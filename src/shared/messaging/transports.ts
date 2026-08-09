import { createTransport, Transporter } from 'nodemailer';
import { SignJWT, importPKCS8 } from 'jose';

/**
 * Low-level outbound transports shared by the notifications channel
 * providers and the comms message providers. Each transport binds only
 * when its configuration exists; endpoints are overridable for tests.
 */

export class SmtpTransport {
  private readonly transporter: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transporter = createTransport(smtpUrl);
  }

  async send(to: string, subject: string, text: string): Promise<string> {
    const info = await this.transporter.sendMail({ from: this.from, to, subject, text });
    return String(info.messageId ?? '');
  }
}

export class TwilioTransport {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly endpoint = 'https://api.twilio.com',
  ) {}

  async send(to: string, body: string): Promise<{ sid: string } | 'failed'> {
    const response = await fetch(
      `${this.endpoint}/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.fromNumber, Body: body }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return 'failed';
    const data = (await response.json()) as { sid: string };
    return { sid: data.sid };
  }
}

interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class FcmTransport {
  private readonly account: FcmServiceAccount;
  private cachedToken?: { token: string; expiresAt: number };

  constructor(
    serviceAccountJson: string,
    private readonly endpoint = 'https://fcm.googleapis.com',
    private readonly tokenEndpoint?: string,
  ) {
    this.account = JSON.parse(serviceAccountJson) as FcmServiceAccount;
  }

  private async accessToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAt > nowSec + 60) {
      return this.cachedToken.token;
    }
    const tokenUri =
      this.tokenEndpoint ?? this.account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const key = await importPKCS8(this.account.private_key, 'RS256');
    const assertion = await new SignJWT({
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.account.client_email)
      .setAudience(tokenUri)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`fcm token request failed: ${response.status}`);
    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { token: data.access_token, expiresAt: nowSec + data.expires_in };
    return data.access_token;
  }

  /** Returns 'invalid_token' when FCM reports the registration is dead. */
  async send(
    deviceToken: string,
    payload: Record<string, unknown>,
  ): Promise<'ok' | 'invalid_token' | 'failed'> {
    const response = await fetch(
      `${this.endpoint}/v1/projects/${this.account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            data: Object.fromEntries(
              Object.entries(payload).map(([k, v]) => [k, String(v)]),
            ),
            android: { priority: 'HIGH' },
            apns: { headers: { 'apns-priority': '10' } },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.ok) return 'ok';
    if (response.status === 404 || response.status === 410) return 'invalid_token';
    const body = await response.text();
    return body.includes('UNREGISTERED') ? 'invalid_token' : 'failed';
  }
}
