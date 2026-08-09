import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Db } from '../src/shared/database/db.service';
import { ReportingService } from '../src/modules/reporting/reporting.service';

describe('reporting & ops (#25)', () => {
  let db: Db;
  let reporting: ReportingService;

  beforeAll(() => {
    db = new Db(new ConfigService());
    reporting = new ReportingService(db);
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  it('aggregates funnel, dispatch, SLA, queues and health without direct identifiers', async () => {
    const [funnel, dispatch, sla, queues, health] = await Promise.all([
      reporting.funnel(),
      reporting.dispatchMetrics(),
      reporting.slaMetrics(),
      reporting.workQueues(),
      reporting.systemHealth(),
    ]);

    expect(funnel).toHaveProperty('listings');
    expect(dispatch).toHaveProperty('claim_rate');
    expect(sla).toHaveProperty('first_response_overdue_open');
    expect(queues).toHaveProperty('ingest_quarantine');
    expect(health).toHaveProperty('outbox_backlog');

    // Pseudonymity: no report payload ever carries an email or phone.
    const serialized = JSON.stringify({ funnel, dispatch, sla, queues, health });
    expect(serialized).not.toMatch(/@example\.com/);
    expect(serialized).not.toMatch(/\+32\d{6,}/);
    // Every leaf value is a number, null, or nested aggregate — never text PII.
    const assertNumeric = (value: unknown): void => {
      if (value === null || typeof value === 'number') return;
      if (typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) assertNumeric(v);
        return;
      }
      throw new Error(`non-numeric leaf in report: ${String(value)}`);
    };
    assertNumeric({ funnel, dispatch, sla, queues, health });
  });
});
