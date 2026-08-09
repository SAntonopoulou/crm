import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { PortfolioService } from '../src/modules/portfolio/portfolio.service';
import { ValuationService } from '../src/modules/portfolio/valuation.service';

const uuid = () => crypto.randomUUID();

describe('portfolio (#29)', () => {
  let db: Db;
  let clock: TestClock;
  let portfolio: PortfolioService;
  let valuation: ValuationService;
  let contacts: ContactsService;

  // Each run gets its own patch of Belgium so comps never leak across tests.
  const baseLat = 50.2 + Math.random() * 0.5;
  const baseLng = 3.6 + Math.random() * 0.5;

  beforeAll(() => {
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-08-16T12:00:00Z'));
    valuation = new ValuationService(db);
    portfolio = new PortfolioService(db, valuation, clock);
    contacts = new ContactsService(db);
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  /** Insert a property (+ optional live sale listing) at an offset from base. */
  async function fixtureProperty(opts: {
    dLat?: number;
    dLng?: number;
    area?: number;
    price?: string;
    kind?: string;
    listed?: boolean;
  }): Promise<string> {
    const prop = await db.kysely
      .insertInto('core.property')
      .values({
        canonical_key: `fixture-${uuid()}`,
        address_normalised: JSON.stringify({ city: 'testville', postcode: '9999' }),
        kind: opts.kind ?? 'apartment',
        floor_area_sqm: String(opts.area ?? 100),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`UPDATE core.property
                 SET geo_point = ST_SetSRID(ST_MakePoint(${baseLng + (opts.dLng ?? 0)}, ${baseLat + (opts.dLat ?? 0)}), 4326)::geography
               WHERE id = ${prop.id}`.execute(db.kysely);
    if (opts.listed !== false && opts.price) {
      await db.kysely
        .insertInto('core.listing')
        .values({
          property_id: prop.id,
          channel: 'sale',
          state: 'live',
          price: opts.price,
        })
        .execute();
    }
    return prop.id;
  }

  it('CRUD with duplicate rejection, events, and tombstones', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const propertyId = await fixtureProperty({ listed: false });

    const entry = await portfolio.add(contactId, {
      property_id: propertyId,
      purchase_price: { amount: '250000.00', currency: 'EUR' },
      monthly_rental_income: { amount: '1100.00', currency: 'EUR' },
      monthly_expenses: { amount: '210.50', currency: 'EUR' },
      outstanding_debt: { amount: '180000.00', currency: 'EUR' },
      monthly_mortgage_payment: { amount: '820.00', currency: 'EUR' },
    });
    expect(entry.status).toBe('watching');
    expect(entry.current_value_estimate).toBeUndefined(); // no comps → absent
    // …but computed_at is stamped anyway: the valuation RAN at creation.
    expect(entry.current_value_estimate_computed_at).not.toBeNull();
    expect(entry.outstanding_debt).toEqual({ amount: '180000.00', currency: 'EUR' });
    expect(entry.monthly_mortgage_payment).toEqual({ amount: '820.00', currency: 'EUR' });

    await expect(
      portfolio.add(contactId, {
        property_id: propertyId,
        purchase_price: { amount: '1.00', currency: 'EUR' },
        monthly_rental_income: { amount: '1.00', currency: 'EUR' },
        monthly_expenses: { amount: '1.00', currency: 'EUR' },
      }),
    ).rejects.toMatchObject({ response: { code: 'portfolio_duplicate' } });

    const updated = await portfolio.update(contactId, propertyId, {
      status: 'owned',
      monthly_rental_income: { amount: '1200.00', currency: 'EUR' },
    });
    expect(updated.status).toBe('owned');
    expect(updated.monthly_rental_income.amount).toBe('1200.00');

    const page = await portfolio.list(contactId);
    expect(page.items).toHaveLength(1);

    await portfolio.remove(contactId, propertyId);
    expect((await portfolio.list(contactId)).items).toHaveLength(0);
    await expect(portfolio.remove(contactId, propertyId)).rejects.toMatchObject({
      response: { code: 'portfolio_entry_not_found' },
    });

    const events = await db.kysely
      .selectFrom('core.outbox_event')
      .select('event_type')
      .where('aggregate_type', '=', 'portfolio_entry')
      .where('event_type', 'like', 'portfolio.entry%')
      .orderBy('seq')
      .execute();
    const types = events.map((e) => e.event_type);
    expect(types).toContain('portfolio.entry_added');
    expect(types).toContain('portfolio.entry_updated');
    expect(types).toContain('portfolio.entry_removed');

    const tombstone = await db.kysely
      .selectFrom('core.tombstone')
      .select('entity_id')
      .where('entity_type', '=', 'portfolio_entry')
      .execute();
    expect(tombstone.length).toBeGreaterThanOrEqual(1);
  });

  it('adaptive radius: 2 km ring first, 5 km only when thin, absent below 5 comps', async () => {
    // Subject: 100 m², apartment.
    const subject = await fixtureProperty({ listed: false });

    // 3 comps inside 2 km (not enough on their own)…
    // €/m²: 3000, 3200, 3400
    await fixtureProperty({ dLat: 0.004, area: 100, price: '300000.00' });
    await fixtureProperty({ dLat: -0.004, area: 100, price: '320000.00' });
    await fixtureProperty({ dLng: 0.006, area: 100, price: '340000.00' });

    expect(await valuation.estimateValue(subject)).toBeUndefined(); // 3 < 5

    // …plus 2 more between 2 km and 5 km → the 5 km ring reaches 5 comps.
    // (0.03° lat ≈ 3.3 km)
    await fixtureProperty({ dLat: 0.03, area: 110, price: '363000.00' }); // 3300/m²
    await fixtureProperty({ dLat: -0.03, area: 90, price: '279000.00' }); // 3100/m²

    const estimate = await valuation.estimateValue(subject);
    expect(estimate).toBeDefined();
    // Median of [3000, 3200, 3400, 3300, 3100] = 3200 €/m² × 100 m²
    expect(estimate!.amount).toBe('320000.00');
    expect(estimate!.currency).toBe('EUR');
  });

  it('comps respect kind and floor-area band; out-of-band listings are ignored', async () => {
    const subject = await fixtureProperty({ dLng: 0.2, listed: false }); // fresh area
    // Wrong kind, wrong size, and too-far comps — none qualify.
    await fixtureProperty({ dLng: 0.2, dLat: 0.003, kind: 'house', area: 100, price: '300000.00' });
    await fixtureProperty({ dLng: 0.2, dLat: -0.003, area: 200, price: '600000.00' }); // area 200 > 130
    await fixtureProperty({ dLng: 0.35, area: 100, price: '300000.00' }); // ~10 km away
    expect(await valuation.estimateValue(subject)).toBeUndefined();
  });

  it('refreshValuations emits only on actual change but stamps computed_at every run', async () => {
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const subject = await fixtureProperty({ dLng: -0.25, listed: false }); // fresh area
    for (let i = 0; i < 5; i++) {
      await fixtureProperty({
        dLng: -0.25,
        dLat: (i - 2) * 0.004,
        area: 100,
        price: `${(2800 + i * 100) * 100}.00`, // 2800..3200 €/m², median 3000
      });
    }

    const countValuationEvents = async () => {
      const rows = await db.kysely
        .selectFrom('core.outbox_event')
        .select(db.kysely.fn.countAll().as('n'))
        .where('event_type', '=', 'portfolio.valuation_updated')
        .executeTakeFirstOrThrow();
      return Number(rows.n);
    };

    // Comps exist → the inline first valuation at add() emits (null → value).
    const before = await countValuationEvents();
    const entry = await portfolio.add(contactId, {
      property_id: subject,
      purchase_price: { amount: '280000.00', currency: 'EUR' },
      monthly_rental_income: { amount: '1000.00', currency: 'EUR' },
      monthly_expenses: { amount: '150.00', currency: 'EUR' },
    });
    expect(entry.current_value_estimate?.amount).toBe('300000.00');
    const afterAdd = await countValuationEvents();
    expect(afterAdd).toBe(before + 1);
    const computedAtCreation = entry.current_value_estimate_computed_at!;

    // No data changed → the run is silent, but computed_at still advances:
    // the client uses it to trust (or caveat) FIRE projections.
    clock.advance(3_600_000);
    await portfolio.refreshValuations();
    expect(await countValuationEvents()).toBe(afterAdd);
    const afterSilent = (await portfolio.list(contactId)).items[0];
    expect(afterSilent.current_value_estimate?.amount).toBe('300000.00');
    expect(
      new Date(afterSilent.current_value_estimate_computed_at!).getTime(),
    ).toBeGreaterThan(new Date(computedAtCreation).getTime());

    // A sixth comp at 4000 €/m² interpolates the median to 3050 → one more
    // event carrying old and new.
    await fixtureProperty({ dLng: -0.25, dLat: 0.012, area: 100, price: '400000.00' });
    await portfolio.refreshValuations();
    const events = await db.kysely
      .selectFrom('core.outbox_event')
      .selectAll()
      .where('event_type', '=', 'portfolio.valuation_updated')
      .orderBy('seq desc')
      .limit(1)
      .execute();
    const payload = events[0].payload as {
      old: { amount: string } | null;
      new: { amount: string } | null;
    };
    expect(payload.old?.amount).toBe('300000.00');
    expect(payload.new?.amount).toBe('305000.00');
  });
});
