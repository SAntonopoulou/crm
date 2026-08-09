import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db } from '../../shared/database/db.service';
import { KmsPort } from './privacy.service';

export class DekDestroyedError extends Error {
  constructor() {
    super('data encryption key destroyed (crypto-shredded)');
  }
}

export class CryptoNotConfiguredError extends Error {
  constructor() {
    super('KMS_MASTER_KEY not configured');
  }
}

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope encryption: per-subject DEKs sealed under the KMS-held master
 * key. Field ciphertexts = iv | tag | data. Deleting a DEK row (KmsPort)
 * makes every ciphertext — including those in backups — unreadable: that
 * is the crypto-shredding guarantee the erasure pipeline relies on.
 */
@Injectable()
export class CryptoService {
  private readonly master?: Buffer;

  constructor(
    private readonly db: Db,
    @Optional() config?: ConfigService,
  ) {
    const key = config?.get<string>('KMS_MASTER_KEY');
    if (key) {
      this.master = Buffer.from(key, 'base64');
      if (this.master.length !== 32) {
        throw new Error('KMS_MASTER_KEY must be 32 bytes, base64-encoded');
      }
    }
  }

  get configured(): boolean {
    return this.master !== undefined;
  }

  async createDek(): Promise<string> {
    if (!this.master) throw new CryptoNotConfiguredError();
    const dek = randomBytes(32);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.master, iv);
    const sealed = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
    const row = await this.db.kysely
      .insertInto('privacy.dek')
      .values({ key_ciphertext: sealed, iv })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async openDek(dekId: string): Promise<Buffer> {
    if (!this.master) throw new CryptoNotConfiguredError();
    const row = await this.db.kysely
      .selectFrom('privacy.dek')
      .select(['key_ciphertext', 'iv'])
      .where('id', '=', dekId)
      .executeTakeFirst();
    if (!row) throw new DekDestroyedError();
    const sealed = row.key_ciphertext as Buffer;
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const data = sealed.subarray(0, sealed.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this.master, row.iv as Buffer);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  async encrypt(dekId: string, plaintext: string): Promise<Buffer> {
    const dek = await this.openDek(dekId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, dek, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  async decrypt(dekId: string, blob: Buffer): Promise<string> {
    const dek = await this.openDek(dekId);
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const data = blob.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGO, dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

/** Real KmsPort: destroying a key deletes the DEK row — shredding done. */
export class DbEnvelopeKms extends KmsPort {
  constructor(private readonly db: Db) {
    super();
  }

  async destroyKey(keyId: string): Promise<void> {
    await this.db.kysely.deleteFrom('privacy.dek').where('id', '=', keyId).execute();
  }
}
