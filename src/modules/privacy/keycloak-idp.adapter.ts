import { ConfigService } from '@nestjs/config';
import { IdpAdminPort } from './privacy.service';

/**
 * Real Keycloak admin adapter, selected when KEYCLOAK_ADMIN_CLIENT_SECRET is
 * configured. The Keycloak user id IS the token `sub`, so erasure and
 * session revocation address users directly by subject id.
 */
export class KeycloakIdpAdmin extends IdpAdminPort {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(config: ConfigService) {
    super();
    this.issuer = config.getOrThrow<string>('KEYCLOAK_ISSUER');
    this.clientId = config.get<string>('KEYCLOAK_ADMIN_CLIENT_ID') ?? 'crm-admin';
    this.clientSecret = config.getOrThrow<string>('KEYCLOAK_ADMIN_CLIENT_SECRET');
  }

  private get adminBase(): string {
    // http://host/realms/crm → http://host/admin/realms/crm
    return this.issuer.replace('/realms/', '/admin/realms/');
  }

  private async token(): Promise<string> {
    const response = await fetch(`${this.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`keycloak token request failed: ${response.status}`);
    }
    const body = (await response.json()) as { access_token: string };
    return body.access_token;
  }

  async deleteSubject(subjectId: string): Promise<void> {
    const response = await fetch(`${this.adminBase}/users/${subjectId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(10_000),
    });
    // 404 = already gone; erasure is idempotent.
    if (!response.ok && response.status !== 404) {
      throw new Error(`keycloak user deletion failed: ${response.status}`);
    }
  }

  async revokeSubjectSessions(subjectId: string): Promise<void> {
    const response = await fetch(`${this.adminBase}/users/${subjectId}/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`keycloak session revocation failed: ${response.status}`);
    }
  }
}
