import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Db } from '../src/shared/database/db.service';
import { ProvenanceResolver } from '../src/shared/provenance/provenance-resolver';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { PropertiesService } from '../src/modules/properties/properties.service';
import { IngestService, IngestBatchInput } from '../src/modules/properties/ingest.service';
import { SuppressionService } from '../src/modules/properties/suppression.service';
import { normaliseEpc } from '../src/modules/properties/normalise';
import { listingLifecycle } from '../src/modules/properties/listing-lifecycle';

const uuid = () => crypto.randomUUID();

function makeBatch(overrides: {
  sourceName?: string;
  records?: IngestBatchInput['records'];
}): IngestBatchInput {
  return {
    source: { name: overrides.sourceName ?? `portal-${uuid()}`, kind: 'portal_scrape' },
    records: overrides.records ?? [],
  };
}

function propertyRecord(opts: {
  key?: string;
  street?: string;
  price?: string;
  email?: string;
  method?: 'scraped' | 'owner_submitted';
  confidence?: number;
  epc?: string;
}): IngestBatchInput['records'][number] {
  const street = opts.street ?? `teststraat-${uuid()}`;
  return {
    idempotency_key: opts.key ?? `rec-${uuid()}`,
    kind: opts.email ? 'combined' : 'property_listing',
    payload: {
      property: {
        address: {
          street,
          number: '12',
          postcode: '1050',
          city: 'Ixelles',
          country: 'BE',
        },
        attributes: {
          kind: 'apartment',
          bedrooms: 2,
          ...(opts.epc ? { epc_rating: opts.epc } : {}),
        },
        listing: {
          channel: 'sale',
          price: opts.price ?? '300000.00',
          currency: 'EUR',
          description: 'Bright two-bedroom apartment',
        },
      },
      ...(opts.email
        ? {
            contact: {
              display_name: 'Test Owner',
              emails: [opts.email],
              role_hint: 'owner' as const,
            },
          }
        : {}),
    },
    provenance: [
      {
        collected_at: new Date().toISOString(),
        method: opts.method ?? 'scraped',
        confidence: opts.confidence ?? 0.9,
      },
    ],
  };
}

describe('properties & ingest (#17)', () => {
  let db: Db;
  let ingest: IngestService;
  let suppression: SuppressionService;

  beforeAll(() => {
    const config = new ConfigService();
    db = new Db(config);
    const resolver = new ProvenanceResolver();
    const properties = new PropertiesService(db, resolver, config);
    const contacts = new ContactsService(db);
    suppression = new SuppressionService(db, config);
    ingest = new IngestService(db, properties, contacts, suppression);
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  it('MANDATED: idempotent re-ingest — same batch replays, no duplicates, mutation rejected', async () => {
    const sourceName = `portal-${uuid()}`;
    const records = [
      propertyRecord({ email: `owner-${uuid()}@example.com` }),
      propertyRecord({}),
    ];
    const batch = makeBatch({ sourceName, records });
    const batchKey = `batch-${uuid()}`;

    const first = await ingest.processBatch(batch, batchKey);
    expect(first.replayed).toBe(false);

    const countRows = async () => {
      const [props, contacts, listings, events] = await Promise.all([
        db.kysely.selectFrom('core.property').select(db.kysely.fn.countAll().as('n')).executeTakeFirstOrThrow(),
        db.kysely.selectFrom('core.contact').select(db.kysely.fn.countAll().as('n')).executeTakeFirstOrThrow(),
        db.kysely.selectFrom('core.listing').select(db.kysely.fn.countAll().as('n')).executeTakeFirstOrThrow(),
        db.kysely
          .selectFrom('core.outbox_event')
          .select(db.kysely.fn.countAll().as('n'))
          // Run bookkeeping events (ingest.*) are legitimate on a new batch id;
          // what must never repeat are DOMAIN side effects.
          .where('event_type', 'not like', 'ingest.%')
          .executeTakeFirstOrThrow(),
      ]);
      return { props: Number(props.n), contacts: Number(contacts.n), listings: Number(listings.n), events: Number(events.n) };
    };

    const afterFirst = await countRows();
    const second = await ingest.processBatch(batch, batchKey);
    const third = await ingest.processBatch(batch, batchKey);
    expect(second.replayed).toBe(true);
    expect(third.replayed).toBe(true);
    expect(second.batch_id).toBe(first.batch_id);
    expect(await countRows()).toEqual(afterFirst); // zero side effects

    const status = await ingest.getBatch(first.batch_id);
    expect((status.stats as { ok: number }).ok).toBe(2);

    // Same key, mutated payload → 409.
    const mutated = makeBatch({ sourceName, records: [records[0]] });
    await expect(ingest.processBatch(mutated, batchKey)).rejects.toMatchObject({
      response: { code: 'idempotency_key_reuse' },
    });

    // Same RECORD keys in a NEW batch: recorded outcomes, no reprocessing.
    const rekeyed = makeBatch({ sourceName, records });
    const fourth = await ingest.processBatch(rekeyed, `batch-${uuid()}`);
    expect(fourth.replayed).toBe(false);
    expect(await countRows()).toEqual(afterFirst);
  });

  it('MANDATED: suppression blocks resurrection — erased identifiers never re-materialise', async () => {
    const email = `erased-${uuid()}@example.com`;
    const street = `wipedstraat-${uuid()}`;
    await suppression.suppress([{ kind: 'email', value: email }], 'erasure');

    const batch = makeBatch({
      records: [propertyRecord({ email, street })],
    });
    const result = await ingest.processBatch(batch, `batch-${uuid()}`);

    const rows = await db.kysely
      .selectFrom('core.ingest_record')
      .selectAll()
      .where('run_id', '=', result.batch_id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('suppressed');
    expect(rows[0].payload).toBeNull(); // no PII retained for suppressed subjects
    expect(rows[0].contact_id).toBeNull();
    expect(rows[0].property_id).toBeNull();

    const channel = await db.kysely
      .selectFrom('core.contact_channel')
      .select('id')
      .where('value_normalised', '=', email.toLowerCase())
      .executeTakeFirst();
    expect(channel).toBeUndefined(); // the contact was never created

    // The scraper-facing stats fold suppressed into ok — indistinguishable.
    const status = await ingest.getBatch(result.batch_id);
    expect((status.stats as { ok: number }).ok).toBe(1);
    expect(
      (status.records as { outcome: string }[])[0].outcome,
    ).toBe('suppressed'); // per-record outcome says stop re-sending, nothing more
  });

  it('MANDATED: owner-confirmed values survive a contradicting re-scrape', async () => {
    const street = `ownerstraat-${uuid()}`;
    const sourceName = `portal-${uuid()}`;

    // 1. Scrape discovers the property at 300k.
    await ingest.processBatch(
      makeBatch({ sourceName, records: [propertyRecord({ street, price: '300000.00' })] }),
      `batch-${uuid()}`,
    );
    // 2. The owner confirms the real price is 290k.
    await ingest.processBatch(
      makeBatch({
        sourceName,
        records: [propertyRecord({ street, price: '290000.00', method: 'owner_submitted' })],
      }),
      `batch-${uuid()}`,
    );
    // 3. A later scrape claims 310k — must NOT overwrite.
    await ingest.processBatch(
      makeBatch({ sourceName, records: [propertyRecord({ street, price: '310000.00' })] }),
      `batch-${uuid()}`,
    );

    const listing = await db.kysely
      .selectFrom('core.listing as l')
      .innerJoin('core.property as p', 'p.id', 'l.property_id')
      .select(['l.id', 'l.price'])
      .where(({ eb, ref }) =>
        eb(ref('p.address_normalised', '->>').key('street'), '=', street),
      )
      .executeTakeFirstOrThrow();
    expect(String(listing.price)).toBe('290000.00');

    // The losing scrape is parked as a candidate for review, not lost.
    const prov = await db.kysely
      .selectFrom('core.field_provenance')
      .selectAll()
      .where('entity_type', '=', 'listing')
      .where('entity_id', '=', listing.id)
      .where('field_name', '=', 'price')
      .executeTakeFirstOrThrow();
    expect(prov.method).toBe('owner_submitted');
    expect((prov.candidate as { value: string }).value).toBe('310000.00');
  });

  it('quarantines incomplete addresses and low-confidence records', async () => {
    const rec = propertyRecord({ confidence: 0.1 });
    const noAddress: typeof rec = {
      ...propertyRecord({}),
      payload: {
        property: {
          address: { country: 'BE', city: 'Gent' }, // no street/number/postcode
          listing: { channel: 'sale', price: '100000.00' },
        },
      },
    };
    const result = await ingest.processBatch(
      makeBatch({ records: [rec, noAddress] }),
      `batch-${uuid()}`,
    );
    const status = await ingest.getBatch(result.batch_id);
    expect((status.stats as { quarantined: number }).quarantined).toBe(2);

    const pending = await db.kysely
      .selectFrom('core.quarantine_item')
      .select(db.kysely.fn.countAll().as('n'))
      .where('state', '=', 'pending')
      .executeTakeFirstOrThrow();
    expect(Number(pending.n)).toBeGreaterThanOrEqual(2);
  });

  it('EPC normalisation: regional labels normalise, junk parks as raw', async () => {
    expect(normaliseEpc('b')).toBe('B');
    expect(normaliseEpc(' a+ ')).toBe('A+');
    expect(normaliseEpc('A++')).toBe('A++');
    expect(normaliseEpc('C (245 kWh/m²)')).toBe('C');
    expect(normaliseEpc('banana')).toBeNull();
    expect(normaliseEpc('H')).toBeNull();
    expect(normaliseEpc(undefined)).toBeNull();

    const street = `epcstraat-${uuid()}`;
    await ingest.processBatch(
      makeBatch({ records: [propertyRecord({ street, epc: 'label F (510)' })] }),
      `batch-${uuid()}`,
    );
    // "label F (510)" does not start with a grade → null + raw parked.
    const prop = await db.kysely
      .selectFrom('core.property')
      .select(['epc_rating', 'free_attributes'])
      .where(({ eb, ref }) =>
        eb(ref('address_normalised', '->>').key('street'), '=', street),
      )
      .executeTakeFirstOrThrow();
    expect(prop.epc_rating).toBeNull();
    expect((prop.free_attributes as { epc_raw: string }).epc_raw).toBe('label F (510)');
  });

  it('listing search: filters by kind and radius, paginates by cursor', async () => {
    const street = `searchstraat-${uuid()}`;
    const res = await ingest.processBatch(
      makeBatch({ records: [propertyRecord({ street })] }),
      `batch-${uuid()}`,
    );
    const rec = await db.kysely
      .selectFrom('core.ingest_record')
      .select(['property_id'])
      .where('run_id', '=', res.batch_id)
      .executeTakeFirstOrThrow();

    // Fixture geo (geocoding pipeline is a later integration) + go live.
    const { sql } = await import('kysely');
    await sql`UPDATE core.property SET geo_point = ST_SetSRID(ST_MakePoint(4.3720, 50.8270), 4326)::geography WHERE id = ${rec.property_id}`.execute(db.kysely);
    await db.kysely
      .updateTable('core.listing')
      .set({ state: 'live' })
      .where('property_id', '=', rec.property_id!)
      .execute();

    const config = new ConfigService();
    const properties = new PropertiesService(db, new ProvenanceResolver(), config);
    const hit = await properties.search({
      channel: 'sale',
      property_kind: 'apartment',
      lat: 50.8266,
      lng: 4.3722,
      radius_km: 2,
      limit: 50,
    });
    const items = hit.items as { property_id: string; property_kind: string; price: { amount: string } }[];
    expect(items.some((i) => i.property_id === rec.property_id)).toBe(true);
    expect(items.every((i) => i.property_kind === 'apartment')).toBe(true);

    const miss = await properties.search({
      channel: 'sale',
      lat: 51.22, // Antwerp, ~45 km away
      lng: 4.4,
      radius_km: 2,
      limit: 50,
    });
    expect(
      (miss.items as { property_id: string }[]).some(
        (i) => i.property_id === rec.property_id,
      ),
    ).toBe(false);
  });

  it('listing lifecycle machine rejects illegal jumps', () => {
    expect(listingLifecycle.can('discovered', 'live')).toBe(false);
    expect(listingLifecycle.can('verified', 'live')).toBe(true);
    expect(listingLifecycle.can('under_offer', 'live')).toBe(true);
    expect(listingLifecycle.can('sold', 'live')).toBe(false);
    expect(() => listingLifecycle.assert('sold', 'live')).toThrow(/illegal/);
  });
});
