import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';
import { Clock } from '../../shared/jobs/clock';

export const JOB_CALENDAR_PUSH = 'calendar.push_event';
export const JOB_CALENDAR_REMOVE = 'calendar.remove_event';
export const JOB_CALENDAR_IMPORT = 'calendar.import_busy';
export const JOB_CALENDAR_IMPORT_ALL = 'calendar.import_all';

export interface CalendarLinkRow {
  id: string;
  agent_id: string;
  provider: string;
  external_calendar_id: string | null;
  credentials: unknown;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
}

/**
 * Google/Outlook seam. The deploy-time adapter owns OAuth token refresh
 * against the stored (encrypted) credentials; interfaces follow both
 * providers' event APIs. Without an adapter everything degrades to no-op —
 * the outbound iCal feed still covers the read case.
 */
export abstract class CalendarSyncPort {
  abstract pushEvent(link: CalendarLinkRow, event: CalendarEvent): Promise<string | null>;
  abstract deleteEvent(link: CalendarLinkRow, externalEventId: string): Promise<void>;
  abstract listBusy(
    link: CalendarLinkRow,
    from: Date,
    to: Date,
  ): Promise<{ start: Date; end: Date }[]>;
}

export class NoopCalendarSync extends CalendarSyncPort {
  async pushEvent(): Promise<string | null> {
    return null;
  }
  async deleteEvent(): Promise<void> {}
  async listBusy(): Promise<{ start: Date; end: Date }[]> {
    return [];
  }
}

const IMPORT_WINDOW_DAYS = 14;
const EXTERNAL_ABSENCE_REASON = 'external_calendar';

@Injectable()
export class CalendarService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly port: CalendarSyncPort,
  ) {}

  /** Claim hook: mirror the viewing into the agent's connected calendars. */
  async pushAppointment(appointmentId: string, agentId: string): Promise<void> {
    const appointment = await this.db.kysely
      .selectFrom('core.appointment as a')
      .innerJoin('core.property as p', 'p.id', 'a.property_id')
      .select([
        'a.id',
        sql<Date>`lower(a.during)`.as('starts_at'),
        sql<Date>`upper(a.during)`.as('ends_at'),
        sql<string | null>`p.address_normalised->>'postcode'`.as('postcode'),
        sql<string | null>`p.address_normalised->>'city'`.as('city'),
      ])
      .where('a.id', '=', appointmentId)
      .executeTakeFirst();
    if (!appointment) return;

    const links = await this.db.kysely
      .selectFrom('core.calendar_link')
      .selectAll()
      .where('agent_id', '=', agentId)
      .where('enabled', '=', true)
      .execute();
    for (const link of links) {
      const externalId = await this.port.pushEvent(link as CalendarLinkRow, {
        id: appointment.id,
        // Coarse location only: full details stay behind the access grant.
        title: `Viewing — ${[appointment.postcode, appointment.city].filter(Boolean).join(' ')}`,
        start: appointment.starts_at,
        end: appointment.ends_at,
      });
      if (externalId) {
        await this.db.kysely
          .insertInto('core.calendar_event_link')
          .values({
            appointment_id: appointmentId,
            calendar_link_id: link.id,
            external_event_id: externalId,
          })
          .onConflict((oc) =>
            oc
              .columns(['appointment_id', 'calendar_link_id'])
              .doUpdateSet({ external_event_id: externalId }),
          )
          .execute();
      }
    }
  }

  /** Withdrawal/cancellation hook: remove mirrored events. */
  async removeAppointment(appointmentId: string): Promise<void> {
    const links = await this.db.kysely
      .selectFrom('core.calendar_event_link as e')
      .innerJoin('core.calendar_link as l', 'l.id', 'e.calendar_link_id')
      .select(['e.id as event_link_id', 'e.external_event_id'])
      .select(['l.id', 'l.agent_id', 'l.provider', 'l.external_calendar_id', 'l.credentials'])
      .where('e.appointment_id', '=', appointmentId)
      .execute();
    for (const row of links) {
      await this.port.deleteEvent(
        {
          id: row.id,
          agent_id: row.agent_id,
          provider: row.provider,
          external_calendar_id: row.external_calendar_id,
          credentials: row.credentials,
        },
        row.external_event_id,
      );
      await this.db.kysely
        .deleteFrom('core.calendar_event_link')
        .where('id', '=', row.event_link_id)
        .execute();
    }
  }

  /**
   * Import external busy windows as agent absences: dispatch ranking's
   * absence exclusion then keeps the agent out of conflicting offers.
   */
  async importBusy(calendarLinkId: string): Promise<number> {
    const link = await this.db.kysely
      .selectFrom('core.calendar_link')
      .selectAll()
      .where('id', '=', calendarLinkId)
      .where('enabled', '=', true)
      .executeTakeFirst();
    if (!link) return 0;

    const from = this.clock.now();
    const to = new Date(from.getTime() + IMPORT_WINDOW_DAYS * 24 * 3_600_000);
    const busy = await this.port.listBusy(link as CalendarLinkRow, from, to);

    await this.db.kysely
      .deleteFrom('core.agent_absence')
      .where('agent_id', '=', link.agent_id)
      .where('reason', '=', EXTERNAL_ABSENCE_REASON)
      .execute();
    for (const window of busy) {
      await this.db.kysely
        .insertInto('core.agent_absence')
        .values({
          agent_id: link.agent_id,
          during: sql`tstzrange(${window.start}, ${window.end})`,
          reason: EXTERNAL_ABSENCE_REASON,
        })
        .execute();
    }
    return busy.length;
  }

  async importAll(): Promise<void> {
    const links = await this.db.kysely
      .selectFrom('core.calendar_link')
      .select('id')
      .where('enabled', '=', true)
      .execute();
    for (const link of links) await this.importBusy(link.id);
  }
}
