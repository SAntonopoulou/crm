import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditLog } from '../../shared/audit/audit-log.service';
import { Db } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { StoragePort } from '../platform/media.service';
import { IdpAdminPort } from './privacy.service';

const PAYOUT_COOLDOWN_HOURS = 72;

/**
 * §14 controls: account recovery (dual DISTINCT staff approval + payout
 * cooldown), bulk-export approval with watermarking, per-subject session
 * revocation through the IdP port.
 */
@Injectable()
export class SecurityService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly idp: IdpAdminPort,
    @Optional() private readonly storage?: StoragePort,
  ) {}

  // ── Account recovery ───────────────────────────────────────────────

  async openRecovery(contactId: string, reason: string, staffId: string): Promise<string> {
    const row = await this.db.kysely
      .insertInto('core.recovery_request')
      .values({ contact_id: contactId, reason })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record({
      actorId: staffId,
      subjectContactId: contactId,
      entityField: 'recovery_request',
      action: 'write',
      context: { recovery_id: row.id },
    });
    return row.id;
  }

  /** Two approvals from two DIFFERENT staff members, enforced here AND by CHECK. */
  async approveRecovery(recoveryId: string, staffId: string): Promise<string> {
    return this.db.tx(async (ctx) => {
      const request = await ctx.trx
        .selectFrom('core.recovery_request')
        .selectAll()
        .where('id', '=', recoveryId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) throw new NotFoundException({ code: 'recovery_not_found' });

      if (request.state === 'open') {
        await ctx.trx
          .updateTable('core.recovery_request')
          .set({ state: 'first_approved', first_approver: staffId })
          .where('id', '=', recoveryId)
          .execute();
        return 'first_approved';
      }
      if (request.state === 'first_approved') {
        if (request.first_approver === staffId) {
          throw new ConflictException({ code: 'same_approver' });
        }
        await ctx.trx
          .updateTable('core.recovery_request')
          .set({ state: 'approved', second_approver: staffId })
          .where('id', '=', recoveryId)
          .execute();
        return 'approved';
      }
      throw new ConflictException({ code: 'state_conflict' });
    });
  }

  /** Completion starts the payout-change cooldown clock. */
  async completeRecovery(recoveryId: string, staffId: string): Promise<Date> {
    const unlockedAt = new Date(
      this.clock.now().getTime() + PAYOUT_COOLDOWN_HOURS * 3_600_000,
    );
    const updated = await this.db.kysely
      .updateTable('core.recovery_request')
      .set({ state: 'completed', payout_change_unlocked_at: unlockedAt })
      .where('id', '=', recoveryId)
      .where('state', '=', 'approved')
      .returning('contact_id')
      .executeTakeFirst();
    if (!updated) throw new ConflictException({ code: 'state_conflict' });
    await this.audit.record({
      actorId: staffId,
      subjectContactId: updated.contact_id,
      entityField: 'recovery_request',
      action: 'write',
      context: { recovery_id: recoveryId, payout_unlocked_at: unlockedAt.toISOString() },
    });
    return unlockedAt;
  }

  /** Payout-detail changes are frozen during the post-recovery cooldown. */
  async payoutChangeAllowed(contactId: string): Promise<boolean> {
    const recent = await this.db.kysely
      .selectFrom('core.recovery_request')
      .select('payout_change_unlocked_at')
      .where('contact_id', '=', contactId)
      .where('state', '=', 'completed')
      .where('payout_change_unlocked_at', '>', this.clock.now())
      .limit(1)
      .executeTakeFirst();
    return recent === undefined;
  }

  // ── Bulk export controls ───────────────────────────────────────────

  async requestExport(staffId: string, criteria: Record<string, unknown>): Promise<string> {
    const row = await this.db.kysely
      .insertInto('core.export_request')
      .values({ requested_by: staffId, criteria: JSON.stringify(criteria) })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async approveExport(exportId: string, staffId: string): Promise<void> {
    const request = await this.db.kysely
      .selectFrom('core.export_request')
      .select(['requested_by', 'state'])
      .where('id', '=', exportId)
      .executeTakeFirst();
    if (!request) throw new NotFoundException({ code: 'export_not_found' });
    if (request.state !== 'pending_approval') {
      throw new ConflictException({ code: 'state_conflict' });
    }
    if (request.requested_by === staffId) {
      throw new ConflictException({ code: 'same_approver' });
    }
    await this.db.kysely
      .updateTable('core.export_request')
      .set({ state: 'approved', approved_by: staffId })
      .where('id', '=', exportId)
      .execute();
  }

  /** Delivery embeds the watermark in every record and audits the export. */
  async deliverExport(exportId: string, staffId: string): Promise<string> {
    if (!this.storage) throw new NotFoundException({ code: 'storage_not_configured' });
    const request = await this.db.kysely
      .selectFrom('core.export_request')
      .selectAll()
      .where('id', '=', exportId)
      .executeTakeFirst();
    if (!request) throw new NotFoundException({ code: 'export_not_found' });
    if (request.state !== 'approved') {
      throw new ConflictException({ code: 'not_approved' });
    }

    const criteria = request.criteria as { entity?: string };
    let records: Record<string, unknown>[] = [];
    if (criteria.entity === 'agents') {
      // Professional data only — no direct identifiers in bulk exports.
      records = await this.db.kysely
        .selectFrom('core.agent_profile')
        .select(['contact_id', 'state', 'languages', 'specialisms', 'capacity_max_active'])
        .execute();
    } else if (criteria.entity === 'listings') {
      records = await this.db.kysely
        .selectFrom('core.listing')
        .select(['id', 'property_id', 'channel', 'state', 'price', 'currency'])
        .execute();
    } else {
      throw new ConflictException({ code: 'unsupported_criteria' });
    }

    const storageKey = `bulk-exports/${exportId}.json`;
    await this.storage.put(
      storageKey,
      Buffer.from(
        JSON.stringify(
          {
            watermark: request.watermark_id,
            generated_at: this.clock.now().toISOString(),
            records: records.map((r) => ({ ...r, _watermark: request.watermark_id })),
          },
          null,
          2,
        ),
      ),
    );
    await this.db.kysely
      .updateTable('core.export_request')
      .set({ state: 'delivered', storage_key: storageKey })
      .where('id', '=', exportId)
      .execute();
    await this.audit.record({
      actorId: staffId,
      entityField: `bulk_export.${criteria.entity}`,
      action: 'export',
      context: { export_id: exportId, watermark: request.watermark_id, count: records.length },
    });
    return storageKey;
  }

  // ── Session revocation ─────────────────────────────────────────────

  async revokeSessions(contactId: string, staffId: string): Promise<void> {
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .select('idp_subject_id')
      .where('id', '=', contactId)
      .executeTakeFirst();
    if (!contact?.idp_subject_id) {
      throw new NotFoundException({ code: 'contact_not_found' });
    }
    await this.idp.revokeSubjectSessions(contact.idp_subject_id);
    await this.audit.record({
      actorId: staffId,
      subjectContactId: contactId,
      entityField: 'idp.sessions',
      action: 'write',
      context: { revoked: true },
    });
  }
}
