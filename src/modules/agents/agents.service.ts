import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { Db, TxContext } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { StateMachine } from '../../shared/state-machine';

export const JOB_DOC_LAPSE_CHECK = 'agents.doc_lapse_check';
export const JOB_SCORECARD_REFRESH = 'agents.scorecard_refresh';

export type AgentState =
  | 'invited'
  | 'onboarding'
  | 'pending_review'
  | 'active'
  | 'suspended'
  | 'rejected'
  | 'offboarded';

/** Agent status machine (domain model §14). */
export const agentMachine = new StateMachine<AgentState>('agent', {
  invited: ['onboarding', 'offboarded'],
  onboarding: ['pending_review', 'offboarded'],
  pending_review: ['active', 'rejected'],
  active: ['suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  rejected: [],
  offboarded: [],
});

const REQUIRED_DOCUMENTS = ['licence', 'insurance'] as const;

@Injectable()
export class AgentsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Start onboarding: profile row + the agent role on the contact. */
  async onboard(contactId: string): Promise<void> {
    await this.db.tx(async (ctx) => {
      const existing = await ctx.trx
        .selectFrom('core.agent_profile')
        .select('contact_id')
        .where('contact_id', '=', contactId)
        .executeTakeFirst();
      if (existing) throw new ConflictException({ code: 'already_agent' });

      await ctx.trx
        .insertInto('core.agent_profile')
        .values({ contact_id: contactId, state: 'onboarding' })
        .execute();
      await ctx.trx
        .insertInto('core.contact_role')
        .values({ contact_id: contactId, role: 'agent' })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await ctx.emit({
        aggregateType: 'agent',
        aggregateId: contactId,
        eventType: 'agent.status_changed',
        payload: { from: 'invited', to: 'onboarding' },
      });
    });
  }

  async submitDocument(
    agentId: string,
    kind: 'licence' | 'insurance' | 'id_document',
    storageKey: string,
    expiresAt?: Date,
  ): Promise<void> {
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.agent_document')
        .values({
          agent_id: agentId,
          kind,
          storage_key: storageKey,
          expires_at: expiresAt ?? null,
        })
        .execute();

      // All required docs present → onboarding advances to review.
      const profile = await this.profileForUpdate(ctx, agentId);
      if (profile.state === 'onboarding') {
        const kinds = await ctx.trx
          .selectFrom('core.agent_document')
          .select('kind')
          .distinct()
          .where('agent_id', '=', agentId)
          .where('verification_state', 'in', ['pending', 'verified'])
          .execute();
        const present = new Set(kinds.map((k) => k.kind));
        if (REQUIRED_DOCUMENTS.every((k) => present.has(k))) {
          await this.applyTransition(ctx, agentId, 'onboarding', 'pending_review');
        }
      }
    });
  }

  async acceptTerms(
    agentId: string,
    ip?: string,
    deviceFingerprint?: string,
  ): Promise<void> {
    await this.db.tx(async (ctx) => {
      const latest = await ctx.trx
        .selectFrom('core.terms_version')
        .select('id')
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      await ctx.trx
        .insertInto('core.terms_acceptance')
        .values({
          agent_id: agentId,
          terms_version_id: latest.id,
          accepted_at: this.clock.now(),
          ip: ip ?? null,
          device_fingerprint: deviceFingerprint ?? null,
        })
        .onConflict((oc) => oc.columns(['agent_id', 'terms_version_id']).doNothing())
        .execute();
      await ctx.emit({
        aggregateType: 'agent',
        aggregateId: agentId,
        eventType: 'agent.terms_accepted',
        payload: {},
      });
    });
  }

  /** Staff approval: verified documents + accepted terms are prerequisites. */
  async approve(agentId: string, staffId: string): Promise<void> {
    await this.db.tx(async (ctx) => {
      const profile = await this.profileForUpdate(ctx, agentId);
      agentMachine.assert(profile.state as AgentState, 'active');

      const accepted = await ctx.trx
        .selectFrom('core.terms_acceptance as ta')
        .innerJoin('core.terms_version as tv', 'tv.id', 'ta.terms_version_id')
        .select('ta.id')
        .where('ta.agent_id', '=', agentId)
        .orderBy('tv.version', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!accepted) throw new ConflictException({ code: 'terms_not_accepted' });

      await ctx.trx
        .updateTable('core.agent_document')
        .set({ verification_state: 'verified', verified_by: staffId })
        .where('agent_id', '=', agentId)
        .where('verification_state', '=', 'pending')
        .execute();
      // Profile expiry columns mirror the verified documents (hot-path read).
      const docs = await ctx.trx
        .selectFrom('core.agent_document')
        .select(['kind', sql<string | null>`max(expires_at)::text`.as('expires')])
        .where('agent_id', '=', agentId)
        .where('verification_state', '=', 'verified')
        .groupBy('kind')
        .execute();
      const expiry = (kind: string) => docs.find((d) => d.kind === kind)?.expires ?? null;
      await ctx.trx
        .updateTable('core.agent_profile')
        .set({
          licence_expires_at: expiry('licence'),
          insurance_expires_at: expiry('insurance'),
        })
        .where('contact_id', '=', agentId)
        .execute();

      await this.applyTransition(ctx, agentId, profile.state as AgentState, 'active');
    });
  }

  /** Guarded transition; suspension leaves the candidate pool atomically. */
  async transition(
    agentId: string,
    to: AgentState,
    opts: { reason?: 'doc_lapse_auto' | 'manual' } = {},
  ): Promise<void> {
    await this.db.tx(async (ctx) => {
      const profile = await this.profileForUpdate(ctx, agentId);
      await this.applyTransition(ctx, agentId, profile.state as AgentState, to, opts.reason);
    });
  }

  /**
   * Nightly job + post-verification hook: agents whose licence or insurance
   * lapsed are suspended in the SAME transaction that marks the document —
   * there is no window where a lapsed agent remains dispatchable.
   */
  async runDocLapseCheck(): Promise<number> {
    const today = this.clock.now();
    const lapsed = await this.db.kysely
      .selectFrom('core.agent_profile')
      .select('contact_id')
      .where('state', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('licence_expires_at', '<', today),
          eb('insurance_expires_at', '<', today),
        ]),
      )
      .execute();

    for (const agent of lapsed) {
      await this.db.tx(async (ctx) => {
        const profile = await this.profileForUpdate(ctx, agent.contact_id);
        if (profile.state !== 'active') return; // raced with manual action
        await ctx.trx
          .updateTable('core.agent_document')
          .set({ verification_state: 'lapsed' })
          .where('agent_id', '=', agent.contact_id)
          .where('verification_state', '=', 'verified')
          .where('expires_at', '<', today)
          .execute();
        await this.applyTransition(ctx, agent.contact_id, 'active', 'suspended', 'doc_lapse_auto');
        await ctx.emit({
          aggregateType: 'agent',
          aggregateId: agent.contact_id,
          eventType: 'agent.suspended_auto',
          payload: {},
        });
      });
    }
    return lapsed.length;
  }

  /** Hourly job: recompute the derived scorecard (concurrently — no lock). */
  async refreshScorecard(): Promise<void> {
    await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY core.agent_scorecard`.execute(
      this.db.kysely,
    );
  }

  /** A renewed, verified document lifts an automatic suspension. */
  async renewDocument(
    agentId: string,
    kind: 'licence' | 'insurance',
    storageKey: string,
    expiresAt: Date,
    verifiedBy: string,
  ): Promise<void> {
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.agent_document')
        .values({
          agent_id: agentId,
          kind,
          storage_key: storageKey,
          expires_at: expiresAt.toISOString().slice(0, 10),
          verification_state: 'verified',
          verified_by: verifiedBy,
        })
        .execute();
      const column = kind === 'licence' ? 'licence_expires_at' : 'insurance_expires_at';
      await ctx.trx
        .updateTable('core.agent_profile')
        .set({ [column]: expiresAt.toISOString().slice(0, 10) })
        .where('contact_id', '=', agentId)
        .execute();

      const profile = await this.profileForUpdate(ctx, agentId);
      const today = this.clock.now().toISOString().slice(0, 10);
      if (
        profile.state === 'suspended' &&
        profile.suspension_reason === 'doc_lapse_auto' &&
        (profile.licence_expires_at === null || String(profile.licence_expires_at) >= today) &&
        (profile.insurance_expires_at === null || String(profile.insurance_expires_at) >= today)
      ) {
        await this.applyTransition(ctx, agentId, 'suspended', 'active');
      }
    });
  }

  async getProfile(agentId: string): Promise<Record<string, unknown>> {
    const profile = await this.db.kysely
      .selectFrom('core.agent_profile')
      .selectAll()
      .where('contact_id', '=', agentId)
      .executeTakeFirst();
    if (!profile) throw new NotFoundException({ code: 'agent_not_found' });
    const coverage = await this.db.kysely
      .selectFrom('core.coverage_area')
      .select(['postcodes', sql<string | null>`ST_AsGeoJSON(area)`.as('area_geojson')])
      .where('agent_id', '=', agentId)
      .execute();
    return {
      contact_id: profile.contact_id,
      state: profile.state,
      suspension_reason: profile.suspension_reason,
      licence_expires_at: profile.licence_expires_at,
      insurance_expires_at: profile.insurance_expires_at,
      languages: profile.languages,
      specialisms: profile.specialisms,
      capacity_max_active: profile.capacity_max_active,
      working_hours: profile.working_hours,
      coverage: {
        postcodes: coverage.flatMap((c) => c.postcodes ?? []),
        polygons: coverage.find((c) => c.area_geojson)
          ? JSON.parse(coverage.find((c) => c.area_geojson)!.area_geojson!)
          : undefined,
      },
    };
  }

  async updateProfile(
    agentId: string,
    patch: {
      languages?: string[];
      specialisms?: string[];
      capacity_max_active?: number;
      working_hours?: Record<string, unknown>;
      coverage?: { polygons?: object; postcodes?: string[] };
    },
  ): Promise<Record<string, unknown>> {
    await this.db.tx(async (ctx) => {
      const updates: Record<string, unknown> = {};
      if (patch.languages) updates.languages = patch.languages;
      if (patch.specialisms) updates.specialisms = patch.specialisms;
      if (patch.capacity_max_active !== undefined)
        updates.capacity_max_active = patch.capacity_max_active;
      if (patch.working_hours) updates.working_hours = JSON.stringify(patch.working_hours);
      if (Object.keys(updates).length > 0) {
        await ctx.trx
          .updateTable('core.agent_profile')
          .set(updates)
          .where('contact_id', '=', agentId)
          .execute();
      }
      if (patch.coverage) {
        await ctx.trx
          .deleteFrom('core.coverage_area')
          .where('agent_id', '=', agentId)
          .execute();
        await ctx.trx
          .insertInto('core.coverage_area')
          .values({
            agent_id: agentId,
            area: patch.coverage.polygons
              ? sql`ST_GeomFromGeoJSON(${JSON.stringify(patch.coverage.polygons)})::geography`
              : null,
            postcodes: patch.coverage.postcodes ?? null,
          })
          .execute();
      }
    });
    return this.getProfile(agentId);
  }

  private async profileForUpdate(ctx: TxContext, agentId: string) {
    const profile = await ctx.trx
      .selectFrom('core.agent_profile')
      .selectAll()
      .where('contact_id', '=', agentId)
      .forUpdate()
      .executeTakeFirst();
    if (!profile) throw new NotFoundException({ code: 'agent_not_found' });
    return profile;
  }

  private async applyTransition(
    ctx: TxContext,
    agentId: string,
    from: AgentState,
    to: AgentState,
    reason?: 'doc_lapse_auto' | 'manual',
  ): Promise<void> {
    agentMachine.assert(from, to);
    await ctx.trx
      .updateTable('core.agent_profile')
      .set({ state: to, suspension_reason: to === 'suspended' ? (reason ?? 'manual') : null })
      .where('contact_id', '=', agentId)
      .execute();
    await ctx.emit({
      aggregateType: 'agent',
      aggregateId: agentId,
      eventType: 'agent.status_changed',
      payload: { from, to, reason: reason ?? null },
    });
  }
}
