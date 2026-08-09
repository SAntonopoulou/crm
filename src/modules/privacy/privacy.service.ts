import {
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { sql } from 'kysely';
import { AuditLog } from '../../shared/audit/audit-log.service';
import { Db } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';
import { ContactsService } from '../contacts/contacts.service';
import { SuppressionService } from '../properties/suppression.service';

export const JOB_DSR_ESCALATION = 'privacy.dsr_escalation';
export const JOB_GRANT_REVOKE = 'privacy.grant_revoke';
export const JOB_RETENTION_SWEEP = 'privacy.retention_sweep';

/** Keycloak admin port — real adapter configured at deploy time. */
export abstract class IdpAdminPort {
  abstract deleteSubject(subjectId: string): Promise<void>;
}

/** KMS port for crypto-shredding: destroying a DEK invalidates backups too. */
export abstract class KmsPort {
  abstract destroyKey(keyId: string): Promise<void>;
}

export class LoggingIdpAdmin extends IdpAdminPort {
  async deleteSubject(): Promise<void> {
    // Deploy-time adapter required; failing loudly beats silently skipping.
    throw new Error('IdP admin adapter not configured');
  }
}

export class LoggingKms extends KmsPort {
  async destroyKey(): Promise<void> {
    throw new Error('KMS adapter not configured');
  }
}

const DSR_SLA_DAYS = 30;
const DSR_ESCALATION_MARGIN_DAYS = 5;

@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly contacts: ContactsService,
    private readonly suppression: SuppressionService,
    private readonly audit: AuditLog,
    private readonly idp: IdpAdminPort,
    private readonly kms: KmsPort,
    @Optional() private readonly jobs?: JobScheduler,
  ) {}

  // ── DSR queue ──────────────────────────────────────────────────────

  async fileDsr(
    contactId: string,
    kind: 'access' | 'rectification' | 'erasure' | 'restriction' | 'portability' | 'objection',
    detail?: string,
  ): Promise<{ id: string; due_at: string; state: string }> {
    const now = this.clock.now();
    const dueAt = new Date(now.getTime() + DSR_SLA_DAYS * 24 * 3_600_000);
    const dsr = await this.db.tx(async (ctx) => {
      const row = await ctx.trx
        .insertInto('privacy.dsr')
        .values({
          contact_id: contactId,
          kind,
          detail: detail ?? null,
          received_at: now,
          due_at: dueAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.emit({
        aggregateType: 'dsr',
        aggregateId: row.id,
        eventType: 'dsr.received',
        payload: { kind },
      });
      return row;
    });
    await this.jobs?.schedule(
      JOB_DSR_ESCALATION,
      { dsrId: dsr.id },
      new Date(dueAt.getTime() - DSR_ESCALATION_MARGIN_DAYS * 24 * 3_600_000),
      { dedupeId: `dsr_esc:${dsr.id}` },
    );
    return { id: dsr.id, due_at: dueAt.toISOString(), state: 'received' };
  }

  async getDsr(contactId: string, dsrId: string): Promise<Record<string, unknown>> {
    const dsr = await this.db.kysely
      .selectFrom('privacy.dsr')
      .selectAll()
      .where('id', '=', dsrId)
      .where('contact_id', '=', contactId)
      .executeTakeFirst();
    if (!dsr) throw new NotFoundException({ code: 'dsr_not_found' });
    return {
      id: dsr.id,
      kind: dsr.kind,
      state: dsr.state,
      received_at: dsr.received_at.toISOString(),
      due_at: dsr.due_at.toISOString(),
    };
  }

  /** Job handler: unfinished DSRs escalate before the one-month deadline bites. */
  async escalateDsr(dsrId: string): Promise<void> {
    await this.db.tx(async (ctx) => {
      const updated = await ctx.trx
        .updateTable('privacy.dsr')
        .set({ state: 'escalated' })
        .where('id', '=', dsrId)
        .where('state', 'in', ['received', 'identity_check', 'in_progress'])
        .returning('id')
        .executeTakeFirst();
      if (!updated) return;
      await ctx.emit({
        aggregateType: 'dsr',
        aggregateId: dsrId,
        eventType: 'dsr.escalated',
        payload: {},
      });
    });
  }

  // ── Erasure orchestration ─────────────────────────────────────────

  /**
   * The full pipeline: capture identifiers → suppression HMACs → IdP
   * deletion → DEK destruction (crypto-shredding) → local scrub +
   * tombstone → completion audit. A failed propagation leaves the DSR
   * in_progress and retryable; nothing is half-erased silently.
   */
  async processErasure(dsrId: string, actorId: string): Promise<void> {
    const dsr = await this.db.kysely
      .selectFrom('privacy.dsr')
      .selectAll()
      .where('id', '=', dsrId)
      .where('kind', '=', 'erasure')
      .executeTakeFirst();
    if (!dsr) throw new NotFoundException({ code: 'dsr_not_found' });
    if (['completed', 'refused'].includes(dsr.state)) return;

    await this.db.kysely
      .updateTable('privacy.dsr')
      .set({ state: 'in_progress' })
      .where('id', '=', dsrId)
      .execute();

    // 1. Capture identifiers BEFORE the scrub destroys them.
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .select(['id', 'idp_subject_id', 'dek_id', 'lifecycle_state'])
      .where('id', '=', dsr.contact_id)
      .executeTakeFirstOrThrow();
    const channels = await this.db.kysely
      .selectFrom('core.contact_channel')
      .select(['kind', 'value_normalised'])
      .where('contact_id', '=', dsr.contact_id)
      .execute();

    // 2. Suppression list — the anti-resurrection guarantee.
    await this.suppression.suppress(
      channels.map((c) => ({
        kind: c.kind as 'email' | 'phone',
        value: c.value_normalised,
      })),
      'erasure',
      dsrId,
    );
    await this.propagation(dsrId, 'suppression_list', 'confirmed');

    // 3. Identity provider deletion (skipped for never-registered subjects).
    if (contact.idp_subject_id) {
      try {
        await this.idp.deleteSubject(contact.idp_subject_id);
        await this.propagation(dsrId, 'keycloak', 'confirmed');
      } catch (err) {
        await this.propagation(dsrId, 'keycloak', 'failed', String(err));
        return; // DSR stays in_progress; ops retries from the queue
      }
    }

    // 4. Crypto-shredding: the DEK dies, so backups die with it.
    if (contact.dek_id) {
      try {
        await this.kms.destroyKey(contact.dek_id);
        await this.propagation(dsrId, 'kms_dek', 'confirmed');
      } catch (err) {
        await this.propagation(dsrId, 'kms_dek', 'failed', String(err));
        return;
      }
    }

    // 5. Local scrub + tombstone (contacts module owns the state machine).
    if (contact.lifecycle_state !== 'erased') {
      await this.contacts.transition(dsr.contact_id, 'erased', actorId);
    }

    // 6. Completion, with the audit trail on the DSR itself.
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .updateTable('privacy.dsr')
        .set({
          state: 'completed',
          completion_audit: JSON.stringify({
            completed_at: this.clock.now().toISOString(),
            actor_id: actorId,
            suppressed_identifiers: channels.length,
            idp_deleted: contact.idp_subject_id !== null,
            dek_destroyed: contact.dek_id !== null,
          }),
        })
        .where('id', '=', dsrId)
        .execute();
      await ctx.emit({
        aggregateType: 'contact',
        aggregateId: dsr.contact_id, // pseudonymous ref: the uuid only
        eventType: 'privacy.erased',
        payload: {},
      });
      await ctx.emit({
        aggregateType: 'dsr',
        aggregateId: dsrId,
        eventType: 'dsr.completed',
        payload: { kind: 'erasure' },
      });
    });
    await this.jobs?.cancel(`dsr_esc:${dsrId}`);
  }

  /** Restriction / objection → Art 18 processing freeze. */
  async applyRestriction(contactId: string, restricted: boolean): Promise<void> {
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .updateTable('core.contact')
        .set({ processing_restricted: restricted })
        .where('id', '=', contactId)
        .execute();
      await ctx.emit({
        aggregateType: 'contact',
        aggregateId: contactId,
        eventType: 'privacy.processing_restricted',
        payload: { restricted },
      });
    });
  }

  // ── Purpose-bound access grants: enforcement ───────────────────────

  /** Job/sweep: revoke grants whose window has closed. */
  async revokeExpiredGrants(): Promise<number> {
    const now = this.clock.now();
    const revoked = await this.db.kysely
      .updateTable('core.access_grant')
      .set({ revoked_at: now })
      .where('revoked_at', 'is', null)
      .where(sql<boolean>`upper(during) <= ${now}`)
      .returning('id')
      .execute();
    return revoked.length;
  }

  private async hasLiveGrant(agentId: string, subjectContactId: string): Promise<boolean> {
    const now = this.clock.now();
    const grant = await this.db.kysely
      .selectFrom('core.access_grant')
      .select('id')
      .where('grantee_agent_id', '=', agentId)
      .where('subject_contact_id', '=', subjectContactId)
      .where('revoked_at', 'is', null)
      .where(sql<boolean>`during @> ${now}::timestamptz`)
      .limit(1)
      .executeTakeFirst();
    return grant !== undefined;
  }

  /**
   * Contact details as an agent sees them: full inside a live grant
   * (read audited), masked outside it. Masking is the default state.
   */
  async contactViewForAgent(
    agentId: string,
    subjectContactId: string,
  ): Promise<{
    contact_id: string;
    display_name: string | null;
    channels: { kind: string; value: string; masked: boolean }[];
  }> {
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .select(['id', 'display_name'])
      .where('id', '=', subjectContactId)
      .executeTakeFirst();
    if (!contact) throw new NotFoundException({ code: 'contact_not_found' });
    const channels = await this.db.kysely
      .selectFrom('core.contact_channel')
      .select(['kind', 'value_normalised'])
      .where('contact_id', '=', subjectContactId)
      .execute();

    const live = await this.hasLiveGrant(agentId, subjectContactId);
    if (live) {
      await this.audit.recordAll(
        channels.map((c) => ({
          actorId: agentId,
          subjectContactId,
          entityField: `contact_channel.${c.kind}`,
          action: 'read' as const,
          context: { purpose: 'claimed_showing' },
        })),
      );
      return {
        contact_id: contact.id,
        display_name: contact.display_name,
        channels: channels.map((c) => ({
          kind: c.kind,
          value: c.value_normalised,
          masked: false,
        })),
      };
    }
    return {
      contact_id: contact.id,
      display_name: contact.display_name ? `${contact.display_name[0]}***` : null,
      channels: channels.map((c) => ({
        kind: c.kind,
        value: mask(c.kind, c.value_normalised),
        masked: true,
      })),
    };
  }

  /** Reveal-on-click outside a grant: a reason is mandatory and audited. */
  async revealChannel(
    agentId: string,
    subjectContactId: string,
    kind: 'email' | 'phone',
    reason: string,
  ): Promise<string> {
    const channel = await this.db.kysely
      .selectFrom('core.contact_channel')
      .select('value_normalised')
      .where('contact_id', '=', subjectContactId)
      .where('kind', '=', kind)
      .orderBy('is_preferred', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!channel) throw new NotFoundException({ code: 'channel_not_found' });
    // AuditLog throws ReasonRequiredError on blank reasons.
    await this.audit.record({
      actorId: agentId,
      subjectContactId,
      entityField: `contact_channel.${kind}`,
      action: 'reveal',
      reason,
    });
    return channel.value_normalised;
  }

  // ── Retention ──────────────────────────────────────────────────────

  /** Nightly sweep: every clock writes its evidence to purge_log. */
  async runRetentionSweep(): Promise<Record<string, number>> {
    const now = this.clock.now();
    const results: Record<string, number> = {};
    const policies = await this.db.kysely
      .selectFrom('privacy.retention_policy')
      .selectAll()
      .execute();

    for (const policy of policies) {
      const cutoff = new Date(now.getTime() - policy.period_days * 24 * 3_600_000);
      let count = 0;

      if (policy.data_category === 'unregistered_scraped_leads') {
        const stale = await this.db.kysely
          .selectFrom('core.contact')
          .select('id')
          .where('lifecycle_state', '=', 'unregistered')
          .where('created_at', '<', cutoff)
          .execute();
        for (const contact of stale) {
          await this.contacts.transition(contact.id, 'erased', 'retention-sweep');
          count++;
        }
      } else if (policy.data_category === 'ingest_payloads') {
        const purged = await this.db.kysely
          .updateTable('core.ingest_record')
          .set({ payload: null })
          .where('created_at', '<', cutoff)
          .where('payload', 'is not', null)
          .returning('id')
          .execute();
        count = purged.length;
      }

      results[policy.data_category] = count;
      await this.db.kysely
        .insertInto('privacy.purge_log')
        .values({
          data_category: policy.data_category,
          purged_count: count,
          ran_at: now,
          detail: JSON.stringify({ cutoff: cutoff.toISOString() }),
        })
        .execute();
    }
    return results;
  }

  // ── Consents ───────────────────────────────────────────────────────

  async listConsents(contactId: string): Promise<unknown[]> {
    return this.db.kysely
      .selectFrom('privacy.consent')
      .select(['purpose', 'wording_version', 'granted_at', 'withdrawn_at'])
      .where('contact_id', '=', contactId)
      .execute();
  }

  async withdrawConsent(contactId: string, purpose: string): Promise<void> {
    await this.db.kysely
      .updateTable('privacy.consent')
      .set({ withdrawn_at: this.clock.now() })
      .where('contact_id', '=', contactId)
      .where('purpose', '=', purpose)
      .where('withdrawn_at', 'is', null)
      .execute();
  }

  private async propagation(
    dsrId: string,
    target: 'keycloak' | 'suppression_list' | 'kms_dek' | 'analytics_store',
    state: 'confirmed' | 'failed',
    detail?: string,
  ): Promise<void> {
    await this.db.kysely
      .insertInto('privacy.erasure_propagation')
      .values({
        dsr_id: dsrId,
        target,
        state,
        detail: detail ?? null,
        confirmed_at: state === 'confirmed' ? this.clock.now() : null,
      })
      .execute();
  }
}

function mask(kind: string, value: string): string {
  if (kind === 'email') {
    const [local, domain] = value.split('@');
    return `${local?.[0] ?? '*'}***@***${domain?.slice(domain.lastIndexOf('.')) ?? ''}`;
  }
  return `${value.slice(0, 3)}*****${value.slice(-2)}`;
}
