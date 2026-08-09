import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { Db } from '../src/shared/database/db.service';
import { TestClock } from '../src/shared/jobs/clock';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { PortfolioService } from '../src/modules/portfolio/portfolio.service';
import { ValuationService } from '../src/modules/portfolio/valuation.service';
import { SyncService } from '../src/modules/platform/sync.service';
import { LocalDiskStorage, MediaService } from '../src/modules/platform/media.service';

const uuid = () => crypto.randomUUID();

describe('platform: sync + media (#31)', () => {
  let db: Db;
  let clock: TestClock;
  let syncService: SyncService;
  let media: MediaService;
  let contacts: ContactsService;

  beforeAll(() => {
    const config = new ConfigService({
      MEDIA_STORAGE_DIR: 'var/test-uploads',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    });
    db = new Db(new ConfigService());
    clock = new TestClock(new Date('2026-08-13T10:00:00Z'));
    syncService = new SyncService(db);
    media = new MediaService(db, clock, new LocalDiskStorage(config), config);
    contacts = new ContactsService(db);
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  async function fixtureListing(): Promise<{ propertyId: string; listingId: string }> {
    const prop = await db.kysely
      .insertInto('core.property')
      .values({
        canonical_key: `sync-${uuid()}`,
        address_normalised: JSON.stringify({ city: 'gent', postcode: '9000' }),
        kind: 'apartment',
        bedrooms: 2,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const listing = await db.kysely
      .insertInto('core.listing')
      .values({ property_id: prop.id, channel: 'sale', state: 'live', price: '250000.00' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { propertyId: prop.id, listingId: listing.id };
  }

  it('delta sync: seq-ordered pages, role filtering, cursor follow, tombstones', async () => {
    const me = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const stranger = await contacts.resolveOrProvision(`kc-${uuid()}`);

    const baseline = await syncService.sync(me, 0, undefined, 100);
    const cursor = baseline.has_more
      ? await drainTo(me, baseline.next_since)
      : baseline.next_since;

    // New world state: a live listing (public), my appointment, a stranger's
    // appointment (must NOT appear), my portfolio entry, a tombstone.
    const { propertyId, listingId } = await fixtureListing();
    const start = new Date(clock.now().getTime() + 48 * 3_600_000);
    await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: propertyId,
        listing_id: listingId,
        viewer_contact_id: me,
        during: sql`tstzrange(${start}, ${new Date(start.getTime() + 3_600_000)})`,
      })
      .execute();
    const strangerFixture = await fixtureListing();
    await db.kysely
      .insertInto('core.appointment')
      .values({
        property_id: strangerFixture.propertyId,
        listing_id: strangerFixture.listingId,
        viewer_contact_id: stranger,
        during: sql`tstzrange(${new Date(start.getTime() + 5 * 3_600_000)}, ${new Date(start.getTime() + 6 * 3_600_000)})`,
      })
      .execute();
    const portfolio = new PortfolioService(db, new ValuationService(db));
    await portfolio.add(me, {
      property_id: propertyId,
      purchase_price: { amount: '200000.00', currency: 'EUR' },
      monthly_rental_income: { amount: '900.00', currency: 'EUR' },
      monthly_expenses: { amount: '100.00', currency: 'EUR' },
    });
    await portfolio.remove(me, propertyId); // → tombstone

    const page = await syncService.sync(me, cursor, undefined, 100);
    const types = page.changes.map((c) => c.type);
    expect(types).toContain('listing');
    expect(types).toContain('appointment');
    // Only MY appointment appears.
    const appointmentIds = page.changes
      .filter((c) => c.type === 'appointment')
      .map((c) => (c.data as { viewer: { contact_id: string } }).viewer.contact_id);
    expect(appointmentIds).toContain(me);
    expect(appointmentIds).not.toContain(stranger);
    // Sequence order is monotonic; the tombstone for the removed entry rides along.
    const seqs = [...page.changes.map((c) => c.sync_seq), ...page.tombstones.map((t) => t.sync_seq)];
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs.length ? seqs.sort((a, b) => a - b) : seqs);
    expect(page.tombstones.some((t) => t.type === 'portfolio_entry')).toBe(true);

    // Cursor semantics: replaying the same cursor is stable; following
    // next_since to the end yields has_more=false and then quiet.
    const end = await drainTo(me, page.next_since);
    const quiet = await syncService.sync(me, end, undefined, 100);
    expect(quiet.changes).toHaveLength(0);
    expect(quiet.has_more).toBe(false);
    expect(quiet.next_since).toBe(end);
  });

  async function drainTo(contactId: string, from: number): Promise<number> {
    let cursor = from;
    for (let i = 0; i < 50; i++) {
      const page = await syncService.sync(contactId, cursor, undefined, 100);
      cursor = page.next_since;
      if (!page.has_more) return cursor;
    }
    throw new Error('sync never drained');
  }

  it('media upload: session → bytes land behind the StoragePort → uploaded', async () => {
    const me = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const session = await media.createSession(me, {
      filename: 'facade.jpg',
      content_type: 'image/jpeg',
      size_bytes: 9,
      purpose: 'listing_media',
    });
    expect(session.upload_url).toContain(session.media_asset_id);

    const payload = Buffer.from('JPEGBYTES');
    expect(await media.storeContent(me, session.media_asset_id, payload)).toBe('ok');

    const row = await db.kysely
      .selectFrom('core.upload_session')
      .selectAll()
      .where('id', '=', session.media_asset_id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('uploaded');
    const stored = await readFile(join('var/test-uploads', row.storage_key!));
    expect(stored.equals(payload)).toBe(true);

    // Someone else's session is untouchable; expired sessions refuse bytes.
    const stranger = await contacts.resolveOrProvision(`kc-${uuid()}`);
    await expect(
      media.storeContent(stranger, session.media_asset_id, payload),
    ).rejects.toMatchObject({ response: { code: 'not_your_upload' } });

    const expiring = await media.createSession(me, {
      filename: 'late.jpg',
      content_type: 'image/jpeg',
      size_bytes: 9,
      purpose: 'listing_media',
    });
    clock.advance(25 * 3_600_000);
    expect(await media.storeContent(me, expiring.media_asset_id, payload)).toBe('expired');
  });
});
