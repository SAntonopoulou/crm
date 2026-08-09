import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, Server, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AuditLog, ReasonRequiredError } from '../src/shared/audit/audit-log.service';
import { Db } from '../src/shared/database/db.service';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { KeycloakIdpAdmin } from '../src/modules/privacy/keycloak-idp.adapter';
import {
  CryptoService,
  DbEnvelopeKms,
  DekDestroyedError,
} from '../src/modules/privacy/crypto.service';
import { SensitiveDataService } from '../src/modules/privacy/sensitive-data.service';
import { S3Storage } from '../src/modules/platform/s3-storage.adapter';
import { FcmTransport, TwilioTransport } from '../src/shared/messaging/transports';
import { NominatimGeocoder } from '../src/modules/properties/nominatim.adapter';
import { normaliseAddress } from '../src/modules/properties/normalise';

const uuid = () => crypto.randomUUID();

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

function fakeServer(
  route: (req: Captured) => { status: number; body?: unknown },
): Promise<{ server: Server; url: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const entry = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        };
        captured.push(entry);
        const out = route(entry);
        res
          .writeHead(out.status, { 'content-type': 'application/json' })
          .end(out.body !== undefined ? JSON.stringify(out.body) : undefined);
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        captured,
      }),
    );
  });
}

describe('launch adapters (#46–50)', () => {
  let db: Db;
  let contacts: ContactsService;

  beforeAll(() => {
    db = new Db(new ConfigService());
    contacts = new ContactsService(db);
  });

  afterAll(async () => {
    await db.kysely.destroy();
  });

  it('#46: Keycloak admin adapter — client-credentials token, delete by sub, logout, idempotent 404', async () => {
    const kc = await fakeServer((req) => {
      if (req.url.includes('/protocol/openid-connect/token')) {
        return { status: 200, body: { access_token: 'fake-admin-token' } };
      }
      if (req.method === 'DELETE' && req.url.includes('/users/gone-')) {
        return { status: 404 };
      }
      return { status: 204 };
    });

    const adapter = new KeycloakIdpAdmin(
      new ConfigService({
        KEYCLOAK_ISSUER: `${kc.url}/realms/crm`,
        KEYCLOAK_ADMIN_CLIENT_ID: 'crm-admin',
        KEYCLOAK_ADMIN_CLIENT_SECRET: 's3cret',
      }),
    );

    await adapter.deleteSubject('subject-123');
    await adapter.revokeSubjectSessions('subject-123');
    await adapter.deleteSubject('gone-already'); // 404 = success (idempotent)

    const tokenCall = kc.captured.find((c) => c.url.includes('/token'))!;
    expect(tokenCall.body).toContain('grant_type=client_credentials');
    expect(tokenCall.body).toContain('client_id=crm-admin');
    const deleteCall = kc.captured.find(
      (c) => c.method === 'DELETE' && c.url.includes('subject-123'),
    )!;
    expect(deleteCall.url).toContain('/admin/realms/crm/users/subject-123');
    expect(deleteCall.headers.authorization).toBe('Bearer fake-admin-token');
    const logoutCall = kc.captured.find((c) => c.url.includes('/logout'))!;
    expect(logoutCall.method).toBe('POST');
    kc.server.close();
  });

  it('#47: envelope crypto — round-trip, ciphertext at rest, shredding kills decryption', async () => {
    const config = new ConfigService(); // KMS_MASTER_KEY from .env
    const cryptoService = new CryptoService(db, config);
    expect(cryptoService.configured).toBe(true);

    const audit = new AuditLog(db);
    const sensitive = new SensitiveDataService(db, cryptoService, audit);
    const contactId = await contacts.resolveOrProvision(`kc-${uuid()}`);
    const iban = 'BE71096123456769';

    await sensitive.setIban(contactId, iban, uuid());
    const row = await db.kysely
      .selectFrom('core.contact_sensitive')
      .select('iban_enc')
      .where('contact_id', '=', contactId)
      .executeTakeFirstOrThrow();
    expect(row.iban_enc).not.toBeNull();
    expect((row.iban_enc as Buffer).toString('utf8')).not.toContain('BE71'); // encrypted at rest

    expect(await sensitive.getIbanMasked(contactId)).toBe('****6769');
    await expect(
      sensitive.revealIban(contactId, uuid(), ' '),
    ).rejects.toThrow(ReasonRequiredError);
    expect(
      await sensitive.revealIban(contactId, uuid(), 'payout verification call'),
    ).toBe(iban);

    // Crypto-shredding: destroy the DEK → every ciphertext is dead, even
    // the one still sitting in the table (and in every backup of it).
    const contact = await db.kysely
      .selectFrom('core.contact')
      .select('dek_id')
      .where('id', '=', contactId)
      .executeTakeFirstOrThrow();
    await new DbEnvelopeKms(db).destroyKey(contact.dek_id!);
    await expect(sensitive.getIbanMasked(contactId)).rejects.toThrow(DekDestroyedError);
  });

  it('#48: S3 storage against live MinIO — bucket auto-create, put/get round-trip', async () => {
    const storage = new S3Storage(new ConfigService()); // S3_* from .env
    const key = `test/${uuid()}.bin`;
    const payload = Buffer.from(`minio-roundtrip-${uuid()}`);
    await storage.put(key, payload);
    expect((await storage.get(key)).equals(payload)).toBe(true);
  });

  it('#49: FCM transport — service-account token flow, data message, UNREGISTERED → invalid_token', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const fcm = await fakeServer((req) => {
      if (req.url.includes('/token')) {
        return { status: 200, body: { access_token: 'fcm-token', expires_in: 3600 } };
      }
      const message = JSON.parse(req.body) as { message: { token: string } };
      if (message.message.token === 'dead-token') {
        return { status: 404, body: { error: { details: [{ errorCode: 'UNREGISTERED' }] } } };
      }
      return { status: 200, body: { name: 'projects/x/messages/1' } };
    });

    const transport = new FcmTransport(
      JSON.stringify({
        project_id: 'crm-test',
        client_email: 'svc@crm-test.iam.example',
        private_key: privateKey,
      }),
      fcm.url,
      `${fcm.url}/token`,
    );
    expect(await transport.send('live-token', { offer_id: 'abc' })).toBe('ok');
    expect(await transport.send('dead-token', {})).toBe('invalid_token');

    const sendCall = fcm.captured.find((c) => c.url.includes('messages:send'))!;
    expect(sendCall.url).toContain('/v1/projects/crm-test/');
    expect(sendCall.headers.authorization).toBe('Bearer fcm-token');
    expect(JSON.parse(sendCall.body).message.data.offer_id).toBe('abc');
    fcm.server.close();
  });

  it('#49: Twilio transport — basic auth, form encoding, failure mapping', async () => {
    const twilio = await fakeServer((req) =>
      req.body.includes('To=%2B32470000001')
        ? { status: 201, body: { sid: 'SM123' } }
        : { status: 400, body: { message: 'bad number' } },
    );
    const transport = new TwilioTransport('AC1', 'tok', '+32460000000', twilio.url);
    expect(await transport.send('+32470000001', 'hello')).toEqual({ sid: 'SM123' });
    expect(await transport.send('nonsense', 'hello')).toBe('failed');

    const call = twilio.captured[0];
    expect(call.url).toContain('/Accounts/AC1/Messages.json');
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from('AC1:tok').toString('base64')}`,
    );
    expect(call.body).toContain('From=%2B32460000000');
    twilio.server.close();
  });

  it('#50: Nominatim geocoder — structured query and confidence mapping', async () => {
    const nominatim = await fakeServer((req) =>
      req.url.includes('postalcode=1050')
        ? { status: 200, body: [{ lat: '50.8266', lon: '4.3722', importance: 0.72 }] }
        : { status: 200, body: [] },
    );
    const geocoder = new NominatimGeocoder(
      new ConfigService({ GEOCODER_URL: nominatim.url }),
    );

    const hit = await geocoder.geocode(
      normaliseAddress({
        street: 'kastanjelaan', number: '12', postcode: '1050',
        city: 'ixelles', country: 'BE',
      }),
    );
    expect(hit).toMatchObject({ lat: 50.8266, lng: 4.3722, confidence: 0.72 });
    expect(nominatim.captured[0].url).toContain('street=12+kastanjelaan');

    const miss = await geocoder.geocode(
      normaliseAddress({ street: 'nowhere', number: '1', postcode: '9999x', city: 'x', country: 'BE' }),
    );
    expect(miss).toBeNull();
    nominatim.server.close();
  });
});
