import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';
import { JWT_KEY_SOURCE } from '../src/shared/auth/token-verifier';
import { Db } from '../src/shared/database/db.service';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { IllegalTransitionError } from '../src/shared/state-machine';

const ISSUER = 'http://localhost:8082/realms/crm';
const uuid = () => crypto.randomUUID();

describe('contacts & identity (#16)', () => {
  let db: Db;
  let service: ContactsService;

  beforeAll(() => {
    db = new Db(new ConfigService());
    service = new ContactsService(db);
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  describe('lifecycle state machine', () => {
    it('walks the legal path and emits events', async () => {
      const sub = `kc-${uuid()}`;
      const id = await service.resolveOrProvision(sub);
      await service.transition(id, 'identity_verified', uuid());
      await service.transition(id, 'suspended', uuid());
      await service.transition(id, 'registered', uuid());

      const events = await db.kysely
        .selectFrom('core.outbox_event')
        .select('payload')
        .where('aggregate_id', '=', id)
        .where('event_type', '=', 'contact.lifecycle_changed')
        .orderBy('seq')
        .execute();
      const moves = events.map((e) => {
        const p = e.payload as { from: string; to: string };
        return `${p.from}>${p.to}`;
      });
      expect(moves).toEqual([
        'unregistered>registered',
        'registered>identity_verified',
        'identity_verified>suspended',
        'suspended>registered',
      ]);
    });

    it('rejects illegal transitions with a typed error', async () => {
      const id = await service.resolveOrProvision(`kc-${uuid()}`);
      await expect(
        service.transition(id, 'unregistered', uuid()),
      ).rejects.toThrow(IllegalTransitionError);

      await service.transition(id, 'erased', uuid());
      await expect(
        service.transition(id, 'registered', uuid()),
      ).rejects.toThrow(IllegalTransitionError);
    });
  });

  describe('erasure side effects (local)', () => {
    it('scrubs channels, identifiers and writes a tombstone; self lookup dies', async () => {
      const sub = `kc-${uuid()}`;
      const id = await service.resolveOrProvision(sub);
      await service.addChannel(id, 'email', 'Erase.Me@Example.COM', true);
      await service.transition(id, 'erased', uuid());

      const contact = await db.kysely
        .selectFrom('core.contact')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(contact.lifecycle_state).toBe('erased');
      expect(contact.idp_subject_id).toBeNull();
      expect(contact.display_name).toBeNull();

      const channels = await db.kysely
        .selectFrom('core.contact_channel')
        .selectAll()
        .where('contact_id', '=', id)
        .execute();
      expect(channels).toHaveLength(0);

      const tombstone = await db.kysely
        .selectFrom('core.tombstone')
        .selectAll()
        .where('entity_type', '=', 'contact')
        .where('entity_id', '=', id)
        .executeTakeFirst();
      expect(tombstone).toBeDefined();

      await expect(service.getSelf(id)).rejects.toMatchObject({
        response: { code: 'contact_not_found' },
      });
      // A fresh login with the same Keycloak subject provisions a NEW contact:
      // the erased record is never resurrected.
      const newId = await service.resolveOrProvision(sub);
      expect(newId).not.toBe(id);
    });
  });

  describe('merge / unmerge', () => {
    async function fixtureContact(email: string, role: 'owner' | 'buyer') {
      const id = await service.resolveOrProvision(`kc-${uuid()}`);
      await service.addChannel(id, 'email', email, true);
      await service.addRole(id, role);
      return id;
    }

    async function stateOf(contactId: string) {
      const contact = await db.kysely
        .selectFrom('core.contact')
        .select(['id', 'lifecycle_state', 'idp_subject_id', 'merged_into'])
        .where('id', '=', contactId)
        .executeTakeFirstOrThrow();
      const channels = await db.kysely
        .selectFrom('core.contact_channel')
        .select(['kind', 'value_normalised', 'is_preferred'])
        .where('contact_id', '=', contactId)
        .orderBy('value_normalised')
        .execute();
      const roles = await db.kysely
        .selectFrom('core.contact_role')
        .select(['role', 'state'])
        .where('contact_id', '=', contactId)
        .orderBy('role')
        .execute();
      return { contact, channels, roles };
    }

    it('merge re-points children, keeps an alias, and unmerge restores exactly', async () => {
      const a = await fixtureContact(`a-${uuid()}@example.com`, 'owner');
      const b = await fixtureContact(`b-${uuid()}@example.com`, 'buyer');
      const before = { a: await stateOf(a), b: await stateOf(b) };

      const mergeId = await service.merge(a, b, uuid());

      const merged = await stateOf(a);
      expect(merged.channels).toHaveLength(2);
      expect(merged.roles.map((r) => r.role).sort()).toEqual(['buyer', 'owner']);
      const alias = await stateOf(b);
      expect(alias.contact.merged_into).toBe(a);
      expect(alias.channels).toHaveLength(0);

      // Alias resolution: the absorbed subject's login lands on the survivor.
      const absorbedSub = before.b.contact.idp_subject_id!;
      expect(await service.resolveOrProvision(absorbedSub)).toBe(a);

      await service.unmerge(mergeId, uuid());
      const after = { a: await stateOf(a), b: await stateOf(b) };
      expect(after).toEqual(before);
    });

    it('merging the same pair twice is rejected', async () => {
      const a = await fixtureContact(`c-${uuid()}@example.com`, 'owner');
      const b = await fixtureContact(`d-${uuid()}@example.com`, 'buyer');
      await service.merge(a, b, uuid());
      await expect(service.merge(a, b, uuid())).rejects.toMatchObject({
        response: { code: 'not_mergeable' },
      });
    });
  });

  describe('/v1/me end-to-end (auth wired)', () => {
    let app: INestApplication;
    let sign: (sub: string) => Promise<string>;

    beforeAll(async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwks = createLocalJWKSet({
        keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig' }],
      });
      sign = (sub) =>
        new SignJWT({ realm_access: { roles: [] } })
          .setProtectedHeader({ alg: 'RS256' })
          .setIssuer(ISSUER)
          .setSubject(sub)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey);

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(JWT_KEY_SOURCE)
        .useValue(jwks)
        .compile();
      app = configureApp(moduleRef.createNestApplication());
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('401 without a token; auto-provisions on first login; PATCH validates', async () => {
      const server = app.getHttpServer();

      await request(server).get('/v1/me').expect(401);

      const token = await sign(`kc-e2e-${uuid()}`);
      const first = await request(server)
        .get('/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(first.body.lifecycle_state).toBe('registered');

      const second = await request(server)
        .get('/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(second.body.id).toBe(first.body.id);

      const patched = await request(server)
        .patch('/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ display_name: 'Sofia Example', locale: 'fr' })
        .expect(200);
      expect(patched.body.display_name).toBe('Sofia Example');
      expect(patched.body.locale).toBe('fr');

      await request(server)
        .patch('/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ locale: 'de' }) // not a supported locale
        .expect(400);

      // /health stays public.
      await request(server).get('/health').expect(200);
    });
  });
});
