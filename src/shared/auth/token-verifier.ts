import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthContext {
  /** Keycloak opaque subject id — the only identity link the CRM stores. */
  sub: string;
  roles: string[];
  /** Authentication Context Class Reference — drives step-up decisions. */
  acr?: string;
  authTime?: number;
}

export class InvalidTokenError extends Error {}

/** Injection point so tests can supply a local JWKS instead of Keycloak's. */
export const JWT_KEY_SOURCE = Symbol('JWT_KEY_SOURCE');

export const keycloakKeySource = (config: ConfigService): JWTVerifyGetKey => {
  const issuer = config.getOrThrow<string>('KEYCLOAK_ISSUER');
  // No fetch happens until the first verification.
  return createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
};

@Injectable()
export class TokenVerifier {
  private readonly issuer: string;

  constructor(
    config: ConfigService,
    @Inject(JWT_KEY_SOURCE) private readonly keySource: JWTVerifyGetKey,
  ) {
    this.issuer = config.getOrThrow<string>('KEYCLOAK_ISSUER');
  }

  async verify(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, this.keySource, {
        issuer: this.issuer,
      });
      if (!payload.sub) throw new InvalidTokenError('token has no subject');
      const realmAccess = payload['realm_access'] as
        | { roles?: string[] }
        | undefined;
      return {
        sub: payload.sub,
        roles: realmAccess?.roles ?? [],
        acr: typeof payload['acr'] === 'string' ? payload['acr'] : undefined,
        authTime:
          typeof payload['auth_time'] === 'number'
            ? payload['auth_time']
            : undefined,
      };
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      throw new InvalidTokenError(`token verification failed: ${String(err)}`);
    }
  }
}
