import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditLog } from '../../shared/audit/audit-log.service';
import { Db } from '../../shared/database/db.service';
import { CryptoService } from './crypto.service';

/**
 * The field-level-encryption write/read paths for direct identifiers
 * (IBAN for agent payouts, national id for identity checks). Values are
 * encrypted under the subject's DEK; reads are masked by default and
 * full reveals demand an audited reason.
 */
@Injectable()
export class SensitiveDataService {
  constructor(
    private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly audit: AuditLog,
  ) {}

  private async ensureDek(contactId: string): Promise<string> {
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .select('dek_id')
      .where('id', '=', contactId)
      .executeTakeFirst();
    if (!contact) throw new NotFoundException({ code: 'contact_not_found' });
    if (contact.dek_id) return contact.dek_id;
    const dekId = await this.crypto.createDek();
    await this.db.kysely
      .updateTable('core.contact')
      .set({ dek_id: dekId })
      .where('id', '=', contactId)
      .execute();
    return dekId;
  }

  async setIban(contactId: string, iban: string, actorId: string): Promise<void> {
    const dekId = await this.ensureDek(contactId);
    const ciphertext = await this.crypto.encrypt(dekId, iban.replace(/\s/g, '').toUpperCase());
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.contact_sensitive')
        .values({ contact_id: contactId, iban_enc: ciphertext })
        .onConflict((oc) =>
          oc.column('contact_id').doUpdateSet({ iban_enc: ciphertext }),
        )
        .execute();
    });
    await this.audit.record({
      actorId,
      subjectContactId: contactId,
      entityField: 'contact_sensitive.iban',
      action: 'write',
    });
  }

  async setNationalId(contactId: string, nationalId: string, actorId: string): Promise<void> {
    const dekId = await this.ensureDek(contactId);
    const ciphertext = await this.crypto.encrypt(dekId, nationalId.trim());
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.contact_sensitive')
        .values({ contact_id: contactId, national_id_enc: ciphertext })
        .onConflict((oc) =>
          oc.column('contact_id').doUpdateSet({ national_id_enc: ciphertext }),
        )
        .execute();
    });
    await this.audit.record({
      actorId,
      subjectContactId: contactId,
      entityField: 'contact_sensitive.national_id',
      action: 'write',
    });
  }

  /** Masked read: last 4 characters only; safe for profile screens. */
  async getIbanMasked(contactId: string): Promise<string | null> {
    const value = await this.readField(contactId, 'iban_enc');
    return value === null ? null : `****${value.slice(-4)}`;
  }

  /** Full reveal demands a reason and lands in the PII audit log. */
  async revealIban(contactId: string, actorId: string, reason: string): Promise<string> {
    await this.audit.record({
      actorId,
      subjectContactId: contactId,
      entityField: 'contact_sensitive.iban',
      action: 'reveal',
      reason,
    });
    const value = await this.readField(contactId, 'iban_enc');
    if (value === null) throw new NotFoundException({ code: 'no_iban_on_file' });
    return value;
  }

  private async readField(
    contactId: string,
    column: 'iban_enc' | 'national_id_enc',
  ): Promise<string | null> {
    const row = await this.db.kysely
      .selectFrom('core.contact_sensitive as s')
      .innerJoin('core.contact as c', 'c.id', 's.contact_id')
      .select([`s.${column}` as 'iban_enc', 'c.dek_id'])
      .where('s.contact_id', '=', contactId)
      .executeTakeFirst();
    if (!row || row.iban_enc === null || row.dek_id === null) return null;
    return this.crypto.decrypt(row.dek_id, row.iban_enc as Buffer);
  }
}
