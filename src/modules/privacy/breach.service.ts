import {
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';
import { JobScheduler } from '../../shared/jobs/job-scheduler';
import { StateMachine } from '../../shared/state-machine';

export const JOB_BREACH_WARNING = 'privacy.breach_warning';

export type BreachState =
  | 'triage'
  | 'assessing'
  | 'notified_dpa'
  | 'notified_subjects'
  | 'closed';

/** Runbook §3: the 72-hour clock starts at AWARENESS, not confirmation. */
export const breachMachine = new StateMachine<BreachState>('breach', {
  triage: ['assessing', 'closed'],
  assessing: ['notified_dpa', 'closed'],
  notified_dpa: ['notified_subjects', 'closed'],
  notified_subjects: ['closed'],
  closed: [],
});

const WARNING_MARGIN_HOURS = 12;

@Injectable()
export class BreachService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    @Optional() private readonly jobs?: JobScheduler,
  ) {}

  /** Opening the incident IS the Art 33(5) record; every action appends. */
  async openIncident(
    staffId: string,
    note: string,
    detectedAt?: Date,
  ): Promise<{ id: string; notify_deadline_at: string }> {
    const detected = detectedAt ?? this.clock.now();
    const deadline = new Date(detected.getTime() + 72 * 3_600_000);
    const incident = await this.db.tx(async (ctx) => {
      const row = await ctx.trx
        .insertInto('privacy.breach_incident')
        .values({
          detected_at: detected,
          notify_deadline_at: deadline,
          timeline: JSON.stringify([
            this.entry(staffId, 'triage', note),
          ]),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.emit({
        aggregateType: 'breach_incident',
        aggregateId: row.id,
        eventType: 'breach.opened',
        payload: { notify_deadline_at: deadline.toISOString() },
      });
      return row;
    });
    await this.jobs?.schedule(
      JOB_BREACH_WARNING,
      { incidentId: incident.id },
      new Date(deadline.getTime() - WARNING_MARGIN_HOURS * 3_600_000),
      { dedupeId: `breach_warn:${incident.id}` },
    );
    return { id: incident.id, notify_deadline_at: deadline.toISOString() };
  }

  async transition(
    incidentId: string,
    to: BreachState,
    staffId: string,
    note: string,
  ): Promise<void> {
    await this.db.tx(async (ctx) => {
      const incident = await ctx.trx
        .selectFrom('privacy.breach_incident')
        .selectAll()
        .where('id', '=', incidentId)
        .forUpdate()
        .executeTakeFirst();
      if (!incident) throw new NotFoundException({ code: 'incident_not_found' });
      breachMachine.assert(incident.state as BreachState, to);
      await ctx.trx
        .updateTable('privacy.breach_incident')
        .set({
          state: to,
          timeline: sql`timeline || ${JSON.stringify([this.entry(staffId, to, note)])}::jsonb`,
        })
        .where('id', '=', incidentId)
        .execute();
      await ctx.emit({
        aggregateType: 'breach_incident',
        aggregateId: incidentId,
        eventType: 'breach.state_changed',
        payload: { to },
      });
    });
  }

  /**
   * High-risk incidents notify subjects (Art 34): placeholder templates
   * carry a PENDING COUNSEL marker until legal copy lands.
   */
  async notifySubjects(
    incidentId: string,
    contactIds: string[],
    staffId: string,
    summary: string,
  ): Promise<void> {
    await this.transition(incidentId, 'notified_subjects', staffId,
      `notifying ${contactIds.length} subjects`);
    for (const contactId of contactIds) {
      await this.jobs?.schedule(
        'notification.send',
        {
          contactId,
          category: 'transactional',
          priority: 'high',
          kind: 'breach_notice',
          payload: { incident_id: incidentId, summary },
        },
        this.clock.now(),
      );
    }
  }

  /** Job handler: T-12h before the 72h mark, unnotified incidents alarm. */
  async deadlineWarning(incidentId: string): Promise<void> {
    const incident = await this.db.kysely
      .selectFrom('privacy.breach_incident')
      .selectAll()
      .where('id', '=', incidentId)
      .executeTakeFirst();
    if (!incident) return;
    if (!['triage', 'assessing'].includes(incident.state)) return; // DPA already notified

    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.task')
        .values({
          kind: 'breach_deadline_warning',
          detail: JSON.stringify({
            incident_id: incidentId,
            notify_deadline_at: incident.notify_deadline_at.toISOString(),
          }),
          due_at: this.clock.now(),
        })
        .execute();
      await ctx.emit({
        aggregateType: 'breach_incident',
        aggregateId: incidentId,
        eventType: 'breach.deadline_warning',
        payload: { hours_remaining: WARNING_MARGIN_HOURS },
      });
    });
  }

  private entry(actorId: string, state: string, note: string) {
    return { at: this.clock.now().toISOString(), actor_id: actorId, state, note };
  }
}
