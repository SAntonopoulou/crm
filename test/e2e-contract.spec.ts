import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';
import { JWT_KEY_SOURCE } from '../src/shared/auth/token-verifier';
import { Db } from '../src/shared/database/db.service';

const ISSUER = 'http://localhost:8082/realms/crm';
const uuid = () => crypto.randomUUID();

/**
 * Contract-conformance smoke: the running HTTP surface behaves like
 * crm-v1.yaml says — auth semantics, resource shapes, problem codes —
 * across the surfaces the client team integrates first.
 */
describe('contract conformance e2e (#44)', () => {
  let app: INestApplication;
  let db: Db;
  let sign: (sub: string, roles?: string[]) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig' }],
    });
    sign = (sub, roles = []) =>
      new SignJWT({ realm_access: { roles } })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JWT_KEY_SOURCE)
      .useValue(jwks)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    db = app.get(Db);
  });

  afterAll(async () => {
    await app.close();
  });

  it('bootstrap: verdict + flags + localized copy + entitlements', async () => {
    const token = await sign(`kc-e2e-${uuid()}`);
    const res = await request(app.getHttpServer())
      .get('/v1/bootstrap')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.version_verdict.status).toBe('ok');
    expect(res.body).toHaveProperty('flags');
    expect(res.body.copy).toHaveProperty('offer_screen_terms');
    expect(Array.isArray(res.body.entitlements)).toBe(true);
  });

  it('role gating: agent surfaces are 403 for non-agents, ops for non-staff', async () => {
    const token = await sign(`kc-e2e-${uuid()}`);
    const server = app.getHttpServer();
    await request(server)
      .get('/v1/agent/offers')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await request(server)
      .get('/v1/ops/funnel')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    // With the realm role, the same surface opens.
    const staffToken = await sign(`kc-e2e-${uuid()}`, ['staff']);
    await request(server)
      .get('/v1/ops/funnel')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
  });

  it('listings search returns the contract page shape', async () => {
    const token = await sign(`kc-e2e-${uuid()}`);
    const res = await request(app.getHttpServer())
      .get('/v1/listings?channel=sale&limit=5')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('next_cursor');
  });

  it('portfolio round-trip per contract 1.2.0 incl. financing fields and problem codes', async () => {
    const server = app.getHttpServer();
    const token = await sign(`kc-e2e-${uuid()}`);
    const property = await db.kysely
      .insertInto('core.property')
      .values({ canonical_key: `e2e-${uuid()}`, address_normalised: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const created = await request(server)
      .post('/v1/me/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .send({
        property_id: property.id,
        purchase_price: { amount: '250000.00', currency: 'EUR' },
        monthly_rental_income: { amount: '1000.00', currency: 'EUR' },
        monthly_expenses: { amount: '150.00', currency: 'EUR' },
        outstanding_debt: { amount: '190000.00', currency: 'EUR' },
        monthly_mortgage_payment: { amount: '850.00', currency: 'EUR' },
      })
      .expect(201);
    expect(created.body.status).toBe('watching');
    expect(created.body.outstanding_debt.amount).toBe('190000.00');
    expect(created.body).toHaveProperty('current_value_estimate_computed_at');
    expect(created.body).not.toHaveProperty('current_value_estimate'); // absent, no comps

    // Duplicate → the contract's 409 problem code.
    const dup = await request(server)
      .post('/v1/me/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .send({
        property_id: property.id,
        purchase_price: { amount: '1.00', currency: 'EUR' },
        monthly_rental_income: { amount: '1.00', currency: 'EUR' },
        monthly_expenses: { amount: '1.00', currency: 'EUR' },
      })
      .expect(409);
    expect(dup.body.code).toBe('portfolio_duplicate');

    // Money format is validated, not coerced.
    await request(server)
      .post('/v1/me/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .send({
        property_id: uuid(),
        purchase_price: { amount: 'not-money', currency: 'EUR' },
        monthly_rental_income: { amount: '1.00', currency: 'EUR' },
        monthly_expenses: { amount: '1.00', currency: 'EUR' },
      })
      .expect(400);

    const patched = await request(server)
      .patch(`/v1/me/portfolio/${property.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'owned' })
      .expect(200);
    expect(patched.body.status).toBe('owned');

    await request(server)
      .delete(`/v1/me/portfolio/${property.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    const list = await request(server)
      .get('/v1/me/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  it('delta sync: since is required; the page shape and cursor semantics hold', async () => {
    const server = app.getHttpServer();
    const token = await sign(`kc-e2e-${uuid()}`);
    await request(server)
      .get('/v1/sync')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    const res = await request(server)
      .get('/v1/sync?since=0&limit=10')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toHaveProperty('changes');
    expect(res.body).toHaveProperty('tombstones');
    expect(res.body).toHaveProperty('next_since');
    expect(res.body).toHaveProperty('has_more');
  });

  it('preference centre corrects transactional opt-outs per contract', async () => {
    const token = await sign(`kc-e2e-${uuid()}`);
    const res = await request(app.getHttpServer())
      .put('/v1/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send([
        { channel: 'push', category: 'transactional', opted_out: true },
        { channel: 'email', category: 'marketing', opted_out: true },
      ])
      .expect(200);
    const transactional = res.body.find(
      (p: { category: string }) => p.category === 'transactional',
    );
    expect(transactional.opted_out).toBe(false);
  });
});
