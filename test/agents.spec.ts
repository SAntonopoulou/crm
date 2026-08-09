import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { AgentsService, agentMachine } from '../src/modules/agents/agents.service';

const uuid = () => crypto.randomUUID();
const DAY = 24 * 3_600_000;

describe('agent registry (#20)', () => {
  let db: Db;
  let clock: TestClock;
  let agents: AgentsService;
  let contacts: ContactsService;

  beforeAll(() => {
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-08-10T08:00:00Z'));
    agents = new AgentsService(db, clock);
    contacts = new ContactsService(db);
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function activeAgent(licenceDaysLeft = 365): Promise<string> {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await agents.onboard(contactId);
    await agents.submitDocument(
      contactId, 'licence', `s3://docs/${uuid()}`,
      new Date(clock.now().getTime() + licenceDaysLeft * DAY),
    );
    await agents.submitDocument(
      contactId, 'insurance', `s3://docs/${uuid()}`,
      new Date(clock.now().getTime() + 365 * DAY),
    );
    await agents.acceptTerms(contactId, '198.51.100.7', 'device-1');
    await agents.approve(contactId, uuid());
    return contactId;
  }

  async function stateOf(agentId: string) {
    return db.kysely
      .selectFrom('core.agent_profile')
      .select(['state', 'suspension_reason'])
      .where('contact_id', '=', agentId)
      .executeTakeFirstOrThrow();
  }

  it('onboarding: documents advance to review, terms gate approval, approval activates', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await agents.onboard(contactId);
    expect((await stateOf(contactId)).state).toBe('onboarding');

    await agents.submitDocument(contactId, 'licence', 's3://docs/l1',
      new Date(clock.now().getTime() + 365 * DAY));
    expect((await stateOf(contactId)).state).toBe('onboarding'); // insurance missing
    await agents.submitDocument(contactId, 'insurance', 's3://docs/i1',
      new Date(clock.now().getTime() + 365 * DAY));
    expect((await stateOf(contactId)).state).toBe('pending_review');

    // No terms acceptance → approval refused.
    await expect(agents.approve(contactId, uuid())).rejects.toMatchObject({
      response: { code: 'terms_not_accepted' },
    });
    await agents.acceptTerms(contactId);
    await agents.approve(contactId, uuid());
    expect((await stateOf(contactId)).state).toBe('active');

    // Contract acceptance is evidenced.
    const acceptance = await db.kysely
      .selectFrom('core.terms_acceptance')
      .selectAll()
      .where('agent_id', '=', contactId)
      .execute();
    expect(acceptance).toHaveLength(1);
  });

  it('machine rejects illegal jumps', () => {
    expect(agentMachine.can('invited', 'active')).toBe(false);
    expect(agentMachine.can('onboarding', 'active')).toBe(false);
    expect(agentMachine.can('pending_review', 'active')).toBe(true);
    expect(agentMachine.can('rejected', 'active')).toBe(false);
    expect(() => agentMachine.assert('offboarded', 'active')).toThrow(/illegal/);
  });

  it('DoD: doc lapse auto-suspends in the same transaction; renewal reinstates', async () => {
    const lapsing = await activeAgent(30); // licence dies in 30 days
    const healthy = await activeAgent(365);

    clock.advance(31 * DAY);
    const suspendedCount = await agents.runDocLapseCheck();
    expect(suspendedCount).toBe(1);

    const after = await stateOf(lapsing);
    expect(after.state).toBe('suspended');
    expect(after.suspension_reason).toBe('doc_lapse_auto');
    expect((await stateOf(healthy)).state).toBe('active');

    // Suspension and the lapsed document mark are atomic — both present.
    const lapsedDocs = await db.kysely
      .selectFrom('core.agent_document')
      .select('id')
      .where('agent_id', '=', lapsing)
      .where('kind', '=', 'licence')
      .where('verification_state', '=', 'lapsed')
      .execute();
    expect(lapsedDocs).toHaveLength(1);

    // Dispatch eligibility is the active-state index: the agent is out.
    const eligible = await db.kysely
      .selectFrom('core.agent_profile')
      .select('contact_id')
      .where('state', '=', 'active')
      .where('contact_id', '=', lapsing)
      .execute();
    expect(eligible).toHaveLength(0);

    const autoEvent = await db.kysely
      .selectFrom('core.outbox_event')
      .select('id')
      .where('event_type', '=', 'agent.suspended_auto')
      .where('aggregate_id', '=', lapsing)
      .execute();
    expect(autoEvent).toHaveLength(1);

    // Re-running the sweep is idempotent (agent no longer active).
    expect(await agents.runDocLapseCheck()).toBe(0);

    // A renewed verified licence lifts the automatic suspension.
    await agents.renewDocument(
      lapsing, 'licence', `s3://docs/${uuid()}`,
      new Date(clock.now().getTime() + 365 * DAY), uuid(),
    );
    expect((await stateOf(lapsing)).state).toBe('active');
  });

  it('manual suspension is not lifted by document renewal', async () => {
    const agentId = await activeAgent();
    await agents.transition(agentId, 'suspended', { reason: 'manual' });
    await agents.renewDocument(
      agentId, 'licence', `s3://docs/${uuid()}`,
      new Date(clock.now().getTime() + 400 * DAY), uuid(),
    );
    const after = await stateOf(agentId);
    expect(after.state).toBe('suspended');
    expect(after.suspension_reason).toBe('manual');
  });

  it('profile update replaces coverage and clamps into the contract shape', async () => {
    const agentId = await activeAgent();
    const profile = await agents.updateProfile(agentId, {
      languages: ['fr', 'nl'],
      specialisms: ['residential'],
      capacity_max_active: 8,
      coverage: { postcodes: ['1050', '1000'] },
    });
    expect(profile).toMatchObject({
      state: 'active',
      languages: ['fr', 'nl'],
      capacity_max_active: 8,
      coverage: { postcodes: ['1050', '1000'] },
    });
  });
});
