import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db, TxContext } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';

export const JOB_SLA_BREACH = 'pipeline.sla_breach';

export interface SlaBreachPayload {
  itemId: string;
  kind: 'first_response' | 'stage';
  /** Stage the timer was armed for — a later stage move voids the breach. */
  stageId?: string;
}

/** Signal weights for lead scoring; env-overridable JSON. */
const DEFAULT_SIGNAL_WEIGHTS: Record<string, number> = {
  price_drop: 10,
  relisting: 5,
  repeat_inquiry: 15,
};

@Injectable()
export class PipelinesService {
  private readonly firstResponseMinutes: number;
  private readonly signalWeights: Record<string, number>;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    @Optional() private readonly jobs?: JobScheduler,
    @Optional() config?: ConfigService,
  ) {
    this.firstResponseMinutes = Number(
      config?.get('FIRST_RESPONSE_SLA_MINUTES') ?? 15,
    );
    try {
      this.signalWeights = config?.get('LEAD_SIGNAL_WEIGHTS')
        ? JSON.parse(config.get<string>('LEAD_SIGNAL_WEIGHTS')!)
        : DEFAULT_SIGNAL_WEIGHTS;
    } catch {
      this.signalWeights = DEFAULT_SIGNAL_WEIGHTS;
    }
  }

  /**
   * Inbound inquiry → demand pipeline. Stamps the time-to-first-response
   * SLA (the single most conversion-critical metric) and arms its timer.
   * Repeated inquiries from the same contact touch the existing item and
   * bump its score instead of duplicating it.
   */
  async recordInboundInquiry(params: {
    contactId: string;
    propertyId?: string;
    payload?: Record<string, unknown>;
  }): Promise<{ itemId: string; repeat: boolean }> {
    const now = this.clock.now();
    return this.db.tx(async (ctx) => {
      const existing = await ctx.trx
        .selectFrom('core.pipeline_item as i')
        .innerJoin('core.pipeline as p', 'p.id', 'i.pipeline_id')
        .select(['i.id'])
        .where('p.kind', '=', 'demand')
        .where('i.contact_id', '=', params.contactId)
        .where('i.state', '=', 'open')
        .where((eb) =>
          params.propertyId
            ? eb('i.property_id', '=', params.propertyId)
            : eb('i.property_id', 'is', null),
        )
        .executeTakeFirst();

      if (existing) {
        await this.applySignal(ctx, existing.id, 'repeat_inquiry');
        await this.logActivity(ctx, {
          contactId: params.contactId,
          propertyId: params.propertyId,
          kind: 'inquiry_repeated',
          payload: params.payload ?? {},
        });
        return { itemId: existing.id, repeat: true };
      }

      const stage = await this.firstStage(ctx, 'demand');
      const dueAt = new Date(now.getTime() + this.firstResponseMinutes * 60_000);
      const item = await ctx.trx
        .insertInto('core.pipeline_item')
        .values({
          pipeline_id: stage.pipeline_id,
          stage_id: stage.id,
          contact_id: params.contactId,
          property_id: params.propertyId ?? null,
          first_response_due_at: dueAt,
          stage_entered_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await this.jobs?.schedule(
        JOB_SLA_BREACH,
        { itemId: item.id, kind: 'first_response' } satisfies SlaBreachPayload,
        dueAt,
        { dedupeId: `first_response:${item.id}` },
      );
      await this.logActivity(ctx, {
        contactId: params.contactId,
        propertyId: params.propertyId,
        kind: 'inquiry_received',
        payload: params.payload ?? {},
      });
      await ctx.emit({
        aggregateType: 'pipeline_item',
        aggregateId: item.id,
        eventType: 'pipeline.item_stage_changed',
        payload: { pipeline_kind: 'demand', from: null, to: stage.name },
      });
      return { itemId: item.id, repeat: false };
    });
  }

  /** Supply-side lead creation from ingest/quarantine acceptance. */
  async createSupplyLead(params: {
    contactId: string;
    propertyId: string;
  }): Promise<string> {
    return this.db.tx(async (ctx) => {
      const stage = await this.firstStage(ctx, 'supply');
      const now = this.clock.now();
      const item = await ctx.trx
        .insertInto('core.pipeline_item')
        .values({
          pipeline_id: stage.pipeline_id,
          stage_id: stage.id,
          contact_id: params.contactId,
          property_id: params.propertyId,
          stage_entered_at: now,
          ...(stage.sla_minutes
            ? { sla_due_at: new Date(now.getTime() + stage.sla_minutes * 60_000) }
            : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (stage.sla_minutes) {
        await this.jobs?.schedule(
          JOB_SLA_BREACH,
          { itemId: item.id, kind: 'stage', stageId: stage.id } satisfies SlaBreachPayload,
          new Date(now.getTime() + stage.sla_minutes * 60_000),
          { dedupeId: `stage_sla:${item.id}` },
        );
      }
      return item.id;
    });
  }

  /** First outbound human response clears the SLA and disarms the timer. */
  async recordFirstResponse(itemId: string, actorId: string): Promise<void> {
    await this.db.tx(async (ctx) => {
      const item = await ctx.trx
        .selectFrom('core.pipeline_item')
        .select(['id', 'contact_id', 'property_id', 'first_response_due_at'])
        .where('id', '=', itemId)
        .forUpdate()
        .executeTakeFirst();
      if (!item) throw new NotFoundException({ code: 'pipeline_item_not_found' });
      if (item.first_response_due_at === null) return; // already answered

      await ctx.trx
        .updateTable('core.pipeline_item')
        .set({ first_response_due_at: null })
        .where('id', '=', itemId)
        .execute();
      await this.logActivity(ctx, {
        contactId: item.contact_id,
        propertyId: item.property_id ?? undefined,
        kind: 'first_response',
        actorId,
      });
    });
    await this.jobs?.cancel(`first_response:${itemId}`);
  }

  async moveStage(
    itemId: string,
    toStageName: string,
    actorId: string | null,
    reason?: string,
  ): Promise<void> {
    const now = this.clock.now();
    let slaJob: { dueAt: Date; stageId: string } | undefined;
    await this.db.tx(async (ctx) => {
      const item = await ctx.trx
        .selectFrom('core.pipeline_item')
        .select(['id', 'pipeline_id', 'stage_id', 'contact_id', 'property_id'])
        .where('id', '=', itemId)
        .forUpdate()
        .executeTakeFirst();
      if (!item) throw new NotFoundException({ code: 'pipeline_item_not_found' });

      const toStage = await ctx.trx
        .selectFrom('core.pipeline_stage')
        .selectAll()
        .where('pipeline_id', '=', item.pipeline_id)
        .where('name', '=', toStageName)
        .executeTakeFirst();
      if (!toStage) throw new NotFoundException({ code: 'stage_not_found' });
      if (toStage.id === item.stage_id) return;

      const fromStage = await ctx.trx
        .selectFrom('core.pipeline_stage')
        .select(['id', 'name'])
        .where('id', '=', item.stage_id)
        .executeTakeFirstOrThrow();

      const dueAt = toStage.sla_minutes
        ? new Date(now.getTime() + toStage.sla_minutes * 60_000)
        : null;
      await ctx.trx
        .updateTable('core.pipeline_item')
        .set({ stage_id: toStage.id, stage_entered_at: now, sla_due_at: dueAt })
        .where('id', '=', itemId)
        .execute();
      await ctx.trx
        .insertInto('core.stage_transition')
        .values({
          item_id: itemId,
          from_stage_id: fromStage.id,
          to_stage_id: toStage.id,
          actor_id: actorId,
          reason: reason ?? null,
        })
        .execute();
      await ctx.emit({
        aggregateType: 'pipeline_item',
        aggregateId: itemId,
        eventType: 'pipeline.item_stage_changed',
        payload: { from: fromStage.name, to: toStage.name },
      });
      await this.logActivity(ctx, {
        contactId: item.contact_id,
        propertyId: item.property_id ?? undefined,
        kind: 'stage_change',
        actorId: actorId ?? undefined,
        payload: { from: fromStage.name, to: toStage.name },
      });
      if (dueAt) slaJob = { dueAt, stageId: toStage.id };
    });
    // Re-arm or disarm the stage timer; dedupe id replaces the previous one.
    if (slaJob) {
      await this.jobs?.schedule(
        JOB_SLA_BREACH,
        { itemId, kind: 'stage', stageId: slaJob.stageId } satisfies SlaBreachPayload,
        slaJob.dueAt,
        { dedupeId: `stage_sla:${itemId}` },
      );
    } else {
      await this.jobs?.cancel(`stage_sla:${itemId}`);
    }
  }

  /**
   * Job handler for SLA timers. Re-checks the condition — the timer may
   * have been made moot between arming and firing — and is idempotent:
   * an already-escalated item never double-fires.
   */
  async handleSlaBreach(payload: SlaBreachPayload): Promise<void> {
    const now = this.clock.now();
    await this.db.tx(async (ctx) => {
      const item = await ctx.trx
        .selectFrom('core.pipeline_item')
        .select(['id', 'stage_id', 'assigned_to', 'first_response_due_at', 'sla_due_at', 'state'])
        .where('id', '=', payload.itemId)
        .forUpdate()
        .executeTakeFirst();
      if (!item || item.state !== 'open') return;

      if (payload.kind === 'first_response') {
        if (
          item.first_response_due_at === null ||
          item.first_response_due_at.getTime() > now.getTime()
        ) {
          return; // answered in time, or timer re-armed later
        }
      } else {
        if (
          item.sla_due_at === null ||
          item.sla_due_at.getTime() > now.getTime() ||
          (payload.stageId && payload.stageId !== item.stage_id)
        ) {
          return; // stage moved on; this timer is void
        }
      }

      const alreadyEscalated = await ctx.trx
        .selectFrom('core.task')
        .select('id')
        .where('item_id', '=', payload.itemId)
        .where('kind', '=', `sla_escalation:${payload.kind}`)
        .where('state', '=', 'open')
        .executeTakeFirst();
      if (alreadyEscalated) return;

      await ctx.trx
        .insertInto('core.task')
        .values({
          item_id: payload.itemId,
          assignee_id: item.assigned_to,
          kind: `sla_escalation:${payload.kind}`,
          detail: JSON.stringify({ breached_at: now.toISOString() }),
          due_at: now,
        })
        .execute();
      await ctx.emit({
        aggregateType: 'pipeline_item',
        aggregateId: payload.itemId,
        eventType: 'pipeline.sla_breached',
        payload: { sla_kind: payload.kind },
      });
    });
  }

  async assignItem(itemId: string, staffContactId: string): Promise<void> {
    await this.db.kysely
      .updateTable('core.pipeline_item')
      .set({ assigned_to: staffContactId })
      .where('id', '=', itemId)
      .execute();
  }

  /** Signal-driven score bump (price_drop, relisting, repeat_inquiry). */
  async applySignal(
    ctx: TxContext,
    itemId: string,
    signal: string,
  ): Promise<void> {
    const weight = this.signalWeights[signal] ?? 0;
    if (weight === 0) return;
    await ctx.trx
      .updateTable('core.pipeline_item')
      .set({ score: sql`score + ${weight}` })
      .where('id', '=', itemId)
      .execute();
  }

  async logActivity(
    ctx: TxContext,
    entry: {
      contactId?: string;
      propertyId?: string;
      kind: string;
      actorId?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await ctx.trx
      .insertInto('core.activity')
      .values({
        contact_id: entry.contactId ?? null,
        property_id: entry.propertyId ?? null,
        kind: entry.kind,
        actor_id: entry.actorId ?? null,
        payload: JSON.stringify(entry.payload ?? {}),
        occurred_at: this.clock.now(),
      })
      .execute();
  }

  private async firstStage(
    ctx: TxContext,
    kind: 'supply' | 'demand',
  ): Promise<{ id: string; pipeline_id: string; name: string; sla_minutes: number | null }> {
    return ctx.trx
      .selectFrom('core.pipeline_stage as s')
      .innerJoin('core.pipeline as p', 'p.id', 's.pipeline_id')
      .select(['s.id', 's.pipeline_id', 's.name', 's.sla_minutes'])
      .where('p.kind', '=', kind)
      .where('p.name', '=', `default_${kind}`)
      .orderBy('s.position')
      .limit(1)
      .executeTakeFirstOrThrow();
  }
}
