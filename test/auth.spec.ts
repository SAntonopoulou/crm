import { describe, expect, it, beforeAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
} from 'jose';
import { TokenVerifier, InvalidTokenError } from '../src/shared/auth/token-verifier';
import { AuthGuard, Public } from '../src/shared/auth/auth.guard';
import { Roles, RolesGuard } from '../src/shared/auth/roles.guard';
import { StepUp, StepUpGuard } from '../src/shared/auth/step-up.guard';
import {
  VersionGateMiddleware,
  compareVersions,
} from '../src/shared/auth/version-gate.middleware';
import { TestClock } from '../src/shared/jobs/clock';

const ISSUER = 'http://localhost:8082/realms/crm';

describe('auth kernel (#15)', () => {
  let verifier: TokenVerifier;
  let sign: (claims: Record<string, unknown>, opts?: { issuer?: string; expired?: boolean }) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwks: JSONWebKeySet = {
      keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig' }],
    };
    const config = new ConfigService({ KEYCLOAK_ISSUER: ISSUER });
    verifier = new TokenVerifier(config, createLocalJWKSet(jwks));
    sign = async (claims, opts) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(opts?.issuer ?? ISSUER)
        .setSubject((claims['sub'] as string) ?? 'subject-1')
        .setIssuedAt()
        .setExpirationTime(opts?.expired ? '-1h' : '1h')
        .sign(privateKey);
  });

  const httpContext = (
    req: Record<string, unknown>,
    handlerMeta: Record<string, unknown> = {},
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handlerMeta['handler'] ?? (() => undefined),
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  describe('token verification', () => {
    it('accepts a valid Keycloak-shaped token and extracts the auth context', async () => {
      const token = await sign({
        sub: 'kc-sub-1',
        realm_access: { roles: ['agent'] },
        acr: 'mfa',
        auth_time: Math.floor(Date.now() / 1000),
      });
      const auth = await verifier.verify(token);
      expect(auth.sub).toBe('kc-sub-1');
      expect(auth.roles).toEqual(['agent']);
      expect(auth.acr).toBe('mfa');
    });

    it('rejects expired tokens and wrong issuers', async () => {
      await expect(
        verifier.verify(await sign({ sub: 's' }, { expired: true })),
      ).rejects.toThrow(InvalidTokenError);
      await expect(
        verifier.verify(await sign({ sub: 's' }, { issuer: 'https://evil.example' })),
      ).rejects.toThrow(InvalidTokenError);
    });
  });

  describe('guards', () => {
    it('AuthGuard attaches req.auth; rejects missing/garbage tokens; honours @Public', async () => {
      const guard = new AuthGuard(new Reflector(), verifier);

      const token = await sign({ sub: 'kc-sub-2', realm_access: { roles: [] } });
      const req: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      expect(await guard.canActivate(httpContext(req))).toBe(true);
      expect((req['auth'] as { sub: string }).sub).toBe('kc-sub-2');

      await expect(
        guard.canActivate(httpContext({ headers: {} })),
      ).rejects.toThrow(/Unauthorized/);
      await expect(
        guard.canActivate(
          httpContext({ headers: { authorization: 'Bearer garbage' } }),
        ),
      ).rejects.toThrow(/Unauthorized/);

      class PublicHandler {
        @Public()
        handle(): void {}
      }
      const publicCtx = httpContext(
        { headers: {} },
        { handler: PublicHandler.prototype.handle },
      );
      expect(await guard.canActivate(publicCtx)).toBe(true);
    });

    it('RolesGuard grants on any matching realm role', () => {
      const guard = new RolesGuard(new Reflector());
      class Handler {
        @Roles('staff', 'staff_admin')
        handle(): void {}
      }
      const meta = { handler: Handler.prototype.handle };
      expect(
        guard.canActivate(
          httpContext({ auth: { sub: 's', roles: ['staff'] } }, meta),
        ),
      ).toBe(true);
      expect(() =>
        guard.canActivate(
          httpContext({ auth: { sub: 's', roles: ['agent'] } }, meta),
        ),
      ).toThrow(/Forbidden/);
    });

    it('StepUpGuard demands fresh MFA for protected actions', () => {
      const clock = new TestClock(new Date('2026-08-09T12:00:00Z'));
      const guard = new StepUpGuard(new Reflector(), clock);
      class Handler {
        @StepUp('first_claim')
        handle(): void {}
      }
      const meta = { handler: Handler.prototype.handle };
      const authTime = Math.floor(clock.now().getTime() / 1000) - 60;

      expect(
        guard.canActivate(
          httpContext({ auth: { sub: 's', roles: [], acr: 'mfa', authTime } }, meta),
        ),
      ).toBe(true);

      // Right ACR but stale session → step up again.
      const staleAuthTime = Math.floor(clock.now().getTime() / 1000) - 7200;
      expect(() =>
        guard.canActivate(
          httpContext(
            { auth: { sub: 's', roles: [], acr: 'mfa', authTime: staleAuthTime } },
            meta,
          ),
        ),
      ).toThrow(/step_up_required|Forbidden/);

      // Fresh session but password-only ACR → step up.
      expect(() =>
        guard.canActivate(
          httpContext({ auth: { sub: 's', roles: [], acr: 'pwd', authTime } }, meta),
        ),
      ).toThrow(/step_up_required|Forbidden/);

      // Unprotected handler unaffected.
      expect(guard.canActivate(httpContext({ auth: undefined }))).toBe(true);
    });
  });

  describe('version gate', () => {
    const middleware = new VersionGateMiddleware(
      new ConfigService({
        APP_MIN_VERSION_IOS: '2.0.0',
        APP_WARN_VERSION_IOS: '2.3.0',
      }),
    );

    const run = (headers: Record<string, string>) => {
      const result = {
        status: 0,
        body: undefined as unknown,
        headers: {} as Record<string, string>,
        nexted: false,
      };
      middleware.use(
        { headers },
        {
          setHeader: (name, value) => void (result.headers[name] = value),
          status: (code) => ({
            json: (body) => {
              result.status = code;
              result.body = body;
            },
          }),
        },
        () => void (result.nexted = true),
      );
      return result;
    };

    it('hard-blocks below min, warns below warn, passes otherwise', () => {
      const blocked = run({ 'x-app-platform': 'ios', 'x-app-version': '1.9.9' });
      expect(blocked.status).toBe(426);
      expect(blocked.nexted).toBe(false);
      expect((blocked.body as { code: string }).code).toBe('app_version_unsupported');

      const warned = run({ 'x-app-platform': 'ios', 'x-app-version': '2.1.0' });
      expect(warned.nexted).toBe(true);
      expect(warned.headers['X-Upgrade-Advised']).toBe('2.3.0');

      const ok = run({ 'x-app-platform': 'ios', 'x-app-version': '2.3.0' });
      expect(ok.nexted).toBe(true);
      expect(ok.headers['X-Upgrade-Advised']).toBeUndefined();

      // No headers (web, server-to-server) → pass through.
      expect(run({}).nexted).toBe(true);
      // Ungated platform → pass through.
      expect(
        run({ 'x-app-platform': 'android', 'x-app-version': '0.0.1' }).nexted,
      ).toBe(true);
    });

    it('compareVersions handles unequal lengths', () => {
      expect(compareVersions('2.0', '2.0.0')).toBe(0);
      expect(compareVersions('2.0.1', '2.0')).toBeGreaterThan(0);
      expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    });
  });
});
