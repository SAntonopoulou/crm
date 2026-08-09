#!/usr/bin/env node
/**
 * Synthetic seed data for local development and staging. SYNTHETIC ONLY:
 * example.com emails, reserved-range phone numbers, invented names.
 * Deterministic (seeded PRNG) so every environment looks the same.
 *
 * Usage: npm run seed   (idempotent — safe to re-run)
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import 'dotenv/config';

let seed = 20260809;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const COMMUNES = [
  { city: 'ixelles', postcode: '1050', lat: 50.8266, lng: 4.3722 },
  { city: 'etterbeek', postcode: '1040', lat: 50.8365, lng: 4.3893 },
  { city: 'schaerbeek', postcode: '1030', lat: 50.8676, lng: 4.3737 },
  { city: 'uccle', postcode: '1180', lat: 50.8022, lng: 4.3389 },
  { city: 'anderlecht', postcode: '1070', lat: 50.8383, lng: 4.3143 },
  { city: 'woluwe', postcode: '1200', lat: 50.8467, lng: 4.4278 },
];
const STREETS = ['kastanjelaan', 'rue des lilas', 'avenue louise', 'beukenstraat', 'rue du moulin', 'lindelaan'];
const FIRST = ['Nora', 'Ward', 'Lina', 'Milan', 'Fien', 'Arno', 'Zoe', 'Stan', 'Amber', 'Kobe'];
const LAST = ['Peeters', 'Janssens', 'Maes', 'Jacobs', 'Willems', 'Claes'];
const KINDS = ['apartment', 'apartment', 'apartment', 'house', 'house', 'commercial'];
const EPC = ['A', 'B', 'B', 'C', 'C', 'D', 'E', 'F'];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // ── 12 active agents with coverage over Brussels ──────────────────
  for (let i = 0; i < 12; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const email = `agent${i}@agents.example.com`;
    const contact = await pool.query(
      `INSERT INTO core.contact (idp_subject_id, lifecycle_state, display_name, locale)
       VALUES ($1, 'identity_verified', $2, $3)
       ON CONFLICT (idp_subject_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [`seed-agent-${i}`, name, pick(['fr', 'nl', 'en'])],
    );
    const agentId = contact.rows[0].id;
    await pool.query(
      `INSERT INTO core.contact_channel (contact_id, kind, value_normalised, verification_state, is_preferred)
       VALUES ($1, 'email', $2, 'verified', true)
       ON CONFLICT DO NOTHING`,
      [agentId, email],
    );
    await pool.query(
      `INSERT INTO core.contact_role (contact_id, role) VALUES ($1, 'agent')
       ON CONFLICT DO NOTHING`,
      [agentId],
    );
    await pool.query(
      `INSERT INTO core.agent_profile (contact_id, state, licence_number,
         licence_expires_at, insurance_expires_at, languages, capacity_max_active)
       VALUES ($1, 'active', $2, now()::date + 365, now()::date + 365, $3, 8)
       ON CONFLICT (contact_id) DO UPDATE SET state = 'active'`,
      [agentId, `IPI-${100000 + i}`, [pick(['fr', 'nl']), 'en']],
    );
    const home = pick(COMMUNES);
    const r = 0.05; // ~4-5 km box
    await pool.query(
      `INSERT INTO core.coverage_area (agent_id, area, postcodes)
       SELECT $1, ST_GeomFromGeoJSON($2)::geography, $3
       WHERE NOT EXISTS (SELECT 1 FROM core.coverage_area WHERE agent_id = $1)`,
      [
        agentId,
        JSON.stringify({
          type: 'MultiPolygon',
          coordinates: [[[
            [home.lng - r, home.lat - r], [home.lng + r, home.lat - r],
            [home.lng + r, home.lat + r], [home.lng - r, home.lat + r],
            [home.lng - r, home.lat - r],
          ]]],
        }),
        COMMUNES.map((c) => c.postcode),
      ],
    );
  }

  // ── 30 properties with live listings ──────────────────────────────
  for (let i = 0; i < 30; i++) {
    const commune = pick(COMMUNES);
    const street = pick(STREETS);
    const number = String(1 + Math.floor(rand() * 120));
    const key = createHash('sha256')
      .update(['BE', street, number, '', commune.postcode].join('|'))
      .digest('hex');
    const area = 45 + Math.floor(rand() * 150);
    const channel = rand() < 0.7 ? 'sale' : 'rent';
    const price = channel === 'sale'
      ? (2200 + Math.floor(rand() * 2400)) * area
      : 9 + Math.floor(rand() * 9) * area;

    const property = await pool.query(
      `INSERT INTO core.property (canonical_key, address_normalised, kind,
         floor_area_sqm, bedrooms, epc_rating, occupancy, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Europe/Brussels')
       ON CONFLICT (canonical_key) DO UPDATE SET kind = EXCLUDED.kind
       RETURNING id`,
      [
        key,
        JSON.stringify({ street, number, postcode: commune.postcode, city: commune.city, country: 'BE' }),
        pick(KINDS),
        area,
        1 + Math.floor(rand() * 4),
        pick(EPC),
        pick(['vacant', 'owner_occupied', 'tenanted']),
      ],
    );
    const propertyId = property.rows[0].id;
    await pool.query(
      `UPDATE core.property
          SET geo_point = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
        WHERE id = $1`,
      [propertyId, commune.lng + (rand() - 0.5) * 0.02, commune.lat + (rand() - 0.5) * 0.02],
    );
    await pool.query(
      `INSERT INTO core.listing (property_id, channel, state, price, description)
       SELECT $1, $2, 'live', $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM core.listing WHERE property_id = $1 AND channel = $2
                           AND state NOT IN ('sold','let','withdrawn','expired'))`,
      [propertyId, channel, price.toFixed(2), `Synthetic ${channel} listing in ${commune.city}.`],
    );
  }

  // ── 10 buyers with requirement profiles ───────────────────────────
  for (let i = 0; i < 10; i++) {
    const contact = await pool.query(
      `INSERT INTO core.contact (idp_subject_id, lifecycle_state, display_name)
       VALUES ($1, 'registered', $2)
       ON CONFLICT (idp_subject_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [`seed-buyer-${i}`, `${pick(FIRST)} ${pick(LAST)}`],
    );
    const buyerId = contact.rows[0].id;
    await pool.query(
      `INSERT INTO core.contact_channel (contact_id, kind, value_normalised, verification_state, is_preferred)
       VALUES ($1, 'email', $2, 'verified', true) ON CONFLICT DO NOTHING`,
      [buyerId, `buyer${i}@buyers.example.com`],
    );
    await pool.query(
      `INSERT INTO core.contact_role (contact_id, role) VALUES ($1, 'buyer')
       ON CONFLICT DO NOTHING`,
      [buyerId],
    );
    const commune = pick(COMMUNES);
    await pool.query(
      `INSERT INTO core.requirement_profile (contact_id, channel, budget_min, budget_max, postcodes, bedrooms_min)
       SELECT $1, 'sale', $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM core.requirement_profile WHERE contact_id = $1)`,
      [buyerId, '150000.00', `${350000 + Math.floor(rand() * 300000)}.00`, [commune.postcode], 1 + Math.floor(rand() * 2)],
    );
  }

  const counts = await pool.query(`
    SELECT (SELECT count(*) FROM core.agent_profile WHERE state = 'active') AS agents,
           (SELECT count(*) FROM core.listing WHERE state = 'live') AS live_listings,
           (SELECT count(*) FROM core.requirement_profile) AS profiles
  `);
  console.log('seeded:', counts.rows[0]);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
