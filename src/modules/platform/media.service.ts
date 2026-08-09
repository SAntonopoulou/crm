import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../../shared/jobs/clock';
import { Db } from '../../shared/database/db.service';

const SESSION_TTL_HOURS = 24;
const MAX_BYTES = 20 * 1024 * 1024;

/** Object-storage seam. S3/GCS adapter at deploy; local disk in dev. */
export abstract class StoragePort {
  abstract put(key: string, data: Buffer): Promise<void>;
  abstract get(key: string): Promise<Buffer>;
}

@Injectable()
export class LocalDiskStorage extends StoragePort {
  private readonly root: string;

  constructor(config: ConfigService) {
    super();
    this.root = config.get<string>('MEDIA_STORAGE_DIR') ?? 'var/uploads';
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(join(this.root, key));
  }
}

/**
 * Upload sessions per the contract. Post-processing (thumbnailing, EXIF
 * stripping, virus scan) hangs off the uploaded state as adapters at
 * deploy time — bytes never ship to clients unprocessed.
 */
@Injectable()
export class MediaService {
  private readonly publicBase: string;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly storage: StoragePort,
    config: ConfigService,
  ) {
    this.publicBase = config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:3000';
  }

  async createSession(
    contactId: string,
    input: {
      filename: string;
      content_type: string;
      size_bytes: number;
      purpose: 'listing_media' | 'agent_document' | 'property_document';
    },
  ): Promise<{ upload_url: string; media_asset_id: string; expires_at: string }> {
    if (input.size_bytes > MAX_BYTES) {
      throw new UnprocessableEntityException({ code: 'file_too_large', max_bytes: MAX_BYTES });
    }
    const expiresAt = new Date(
      this.clock.now().getTime() + SESSION_TTL_HOURS * 3_600_000,
    );
    const session = await this.db.kysely
      .insertInto('core.upload_session')
      .values({
        contact_id: contactId,
        purpose: input.purpose,
        filename: input.filename,
        content_type: input.content_type,
        size_bytes: input.size_bytes,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      upload_url: `${this.publicBase}/v1/media/uploads/${session.id}/content`,
      media_asset_id: session.id,
      expires_at: expiresAt.toISOString(),
    };
  }

  async storeContent(
    contactId: string,
    sessionId: string,
    data: Buffer,
  ): Promise<'ok' | 'expired'> {
    const session = await this.db.kysely
      .selectFrom('core.upload_session')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) throw new NotFoundException({ code: 'upload_not_found' });
    if (session.contact_id !== contactId) {
      throw new ForbiddenException({ code: 'not_your_upload' });
    }
    if (session.expires_at.getTime() <= this.clock.now().getTime()) return 'expired';
    if (data.length === 0 || data.length > MAX_BYTES) {
      throw new UnprocessableEntityException({ code: 'invalid_content_length' });
    }

    const key = `${session.purpose}/${sessionId}/${session.filename}`;
    await this.storage.put(key, data);
    await this.db.kysely
      .updateTable('core.upload_session')
      .set({ storage_key: key, state: 'uploaded' })
      .where('id', '=', sessionId)
      .execute();
    return 'ok';
  }
}
