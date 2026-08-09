import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';

/**
 * Ops console & reporting (domain model §16). Everything here aggregates —
 * no direct identifiers leave this module (tested), pseudonymous ids only.
 */
@Injectable()
export class ReportingService {
  constructor(private readonly db: Db) {}

  /** Funnel: conversion counts and stage flow at a glance. */
  async funnel(): Promise<Record<string, unknown>> {
    const [listings, appointments, dispatches, outcomes] = await Promise.all([
      this.countBy('core.listing', 'state'),
      this.countBy('core.appointment', 'state'),
      this.countBy('core.dispatch', 'state'),
      this.countBy('core.viewing_outcome', 'outcome'),
    ]);
    return { listings, appointments, dispatches, outcomes };
  }

  /** Dispatch health: the conversion-critical latency numbers. */
  async dispatchMetrics(): Promise<Record<string, unknown>> {
    const timing = await sql<{
      p50_seconds: string | null;
      p95_seconds: string | null;
      claim_rate: string | null;
    }>`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM claimed_at - created_at))::text AS p50_seconds,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM claimed_at - created_at))::text AS p95_seconds,
        (count(*) FILTER (WHERE state = 'claimed'))::numeric
          / NULLIF(count(*) FILTER (WHERE state IN ('claimed','no_agent','cancelled')), 0) AS claim_rate
      FROM core.dispatch
    `.execute(this.db.kysely);
    const offers = await this.countBy('core.dispatch_offer', 'state');
    return {
      time_to_claim_p50_seconds: timing.rows[0]?.p50_seconds ? Number(timing.rows[0].p50_seconds) : null,
      time_to_claim_p95_seconds: timing.rows[0]?.p95_seconds ? Number(timing.rows[0].p95_seconds) : null,
      claim_rate: timing.rows[0]?.claim_rate ? Number(timing.rows[0].claim_rate) : null,
      offers,
    };
  }

  /** First-response SLA: the single most conversion-critical metric. */
  async slaMetrics(): Promise<Record<string, unknown>> {
    const rows = await sql<{ open_overdue: string; breached_total: string }>`
      SELECT
        (SELECT count(*) FROM core.pipeline_item
          WHERE first_response_due_at IS NOT NULL AND first_response_due_at < now())::text AS open_overdue,
        (SELECT count(*) FROM core.task WHERE kind LIKE 'sla_escalation:%')::text AS breached_total
    `.execute(this.db.kysely);
    return {
      first_response_overdue_open: Number(rows.rows[0].open_overdue),
      sla_escalations_total: Number(rows.rows[0].breached_total),
    };
  }

  /** Work queues for the ops console. */
  async workQueues(): Promise<Record<string, number>> {
    const rows = await sql<{
      quarantine: string;
      onboarding: string;
      disputes: string;
      dsrs: string;
      unstaffed: string;
    }>`
      SELECT
        (SELECT count(*) FROM core.quarantine_item WHERE state = 'pending')::text AS quarantine,
        (SELECT count(*) FROM core.agent_profile WHERE state = 'pending_review')::text AS onboarding,
        (SELECT count(*) FROM core.dispute WHERE state = 'open')::text AS disputes,
        (SELECT count(*) FROM privacy.dsr WHERE state NOT IN ('completed','refused'))::text AS dsrs,
        (SELECT count(*) FROM core.appointment WHERE state = 'unstaffed')::text AS unstaffed
    `.execute(this.db.kysely);
    const r = rows.rows[0];
    return {
      ingest_quarantine: Number(r.quarantine),
      agent_onboarding: Number(r.onboarding),
      attribution_disputes: Number(r.disputes),
      open_dsrs: Number(r.dsrs),
      unstaffed_appointments: Number(r.unstaffed),
    };
  }

  /** System health: volumes and delivery rates. */
  async systemHealth(): Promise<Record<string, unknown>> {
    const rows = await sql<{
      unpublished_events: string;
      ingest_failed_7d: string;
      ingest_ok_7d: string;
      notifications_exhausted_7d: string;
      notifications_total_7d: string;
    }>`
      SELECT
        (SELECT count(*) FROM core.outbox_event WHERE published_at IS NULL)::text AS unpublished_events,
        (SELECT count(*) FROM core.ingest_record
          WHERE outcome = 'failed' AND created_at > now() - interval '7 days')::text AS ingest_failed_7d,
        (SELECT count(*) FROM core.ingest_record
          WHERE outcome IN ('created','updated','unchanged','suppressed')
            AND created_at > now() - interval '7 days')::text AS ingest_ok_7d,
        (SELECT count(*) FROM core.notification
          WHERE state = 'exhausted' AND created_at > now() - interval '7 days')::text AS notifications_exhausted_7d,
        (SELECT count(*) FROM core.notification
          WHERE created_at > now() - interval '7 days')::text AS notifications_total_7d
    `.execute(this.db.kysely);
    const r = rows.rows[0];
    return {
      outbox_backlog: Number(r.unpublished_events),
      ingest_failed_7d: Number(r.ingest_failed_7d),
      ingest_ok_7d: Number(r.ingest_ok_7d),
      notifications_exhausted_7d: Number(r.notifications_exhausted_7d),
      notifications_total_7d: Number(r.notifications_total_7d),
    };
  }

  private async countBy(table: string, column: string): Promise<Record<string, number>> {
    const rows = await sql<{ key: string; n: string }>`
      SELECT ${sql.ref(column)}::text AS key, count(*)::text AS n
        FROM ${sql.table(table)}
       GROUP BY ${sql.ref(column)}
    `.execute(this.db.kysely);
    return Object.fromEntries(rows.rows.map((r) => [r.key, Number(r.n)]));
  }

}
