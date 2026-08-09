import { ConfigService } from '@nestjs/config';
import { Db } from '../../shared/database/db.service';
import {
  FcmTransport,
  SmtpTransport,
  TwilioTransport,
} from '../../shared/messaging/transports';
import {
  ChannelProvider,
  ProviderResult,
  ProviderRegistry,
} from './notifications.service';

class FcmChannelProvider implements ChannelProvider {
  constructor(private readonly fcm: FcmTransport) {}

  async send(input: {
    deviceToken?: string;
    payload: unknown;
  }): Promise<ProviderResult> {
    if (!input.deviceToken) return 'failed';
    return this.fcm.send(
      input.deviceToken,
      (input.payload ?? {}) as Record<string, unknown>,
    );
  }
}

class SmsChannelProvider implements ChannelProvider {
  constructor(
    private readonly db: Db,
    private readonly twilio: TwilioTransport,
  ) {}

  async send(input: { contactId: string; payload: unknown }): Promise<ProviderResult> {
    const phone = await preferredChannel(this.db, input.contactId, 'phone');
    if (!phone) return 'failed';
    const result = await this.twilio.send(
      phone,
      `Property Platform: you have a time-critical update. Open the app. (${JSON.stringify(input.payload).slice(0, 100)})`,
    );
    return result === 'failed' ? 'failed' : 'ok';
  }
}

class EmailChannelProvider implements ChannelProvider {
  constructor(
    private readonly db: Db,
    private readonly smtp: SmtpTransport,
  ) {}

  async send(input: { contactId: string; payload: unknown }): Promise<ProviderResult> {
    const email = await preferredChannel(this.db, input.contactId, 'email');
    if (!email) return 'failed';
    try {
      await this.smtp.send(
        email,
        'Property Platform — action needed',
        `You have a time-critical update waiting in the app.\n\n${JSON.stringify(input.payload)}`,
      );
      return 'ok';
    } catch {
      return 'failed';
    }
  }
}

async function preferredChannel(
  db: Db,
  contactId: string,
  kind: 'email' | 'phone',
): Promise<string | null> {
  const row = await db.kysely
    .selectFrom('core.contact_channel')
    .select('value_normalised')
    .where('contact_id', '=', contactId)
    .where('kind', '=', kind)
    .orderBy('is_preferred', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.value_normalised ?? null;
}

/** Bind each real channel provider iff its configuration exists. */
export function bindChannelProviders(
  registry: ProviderRegistry,
  db: Db,
  config: ConfigService,
): void {
  const fcmAccount = config.get<string>('FCM_SERVICE_ACCOUNT');
  if (fcmAccount) {
    registry.bind(
      'push',
      new FcmChannelProvider(
        new FcmTransport(
          fcmAccount,
          config.get('FCM_ENDPOINT') ?? undefined,
          config.get('FCM_TOKEN_ENDPOINT') ?? undefined,
        ),
      ),
    );
  }
  const twilioSid = config.get<string>('TWILIO_ACCOUNT_SID');
  if (twilioSid) {
    registry.bind(
      'sms',
      new SmsChannelProvider(
        db,
        new TwilioTransport(
          twilioSid,
          config.getOrThrow('TWILIO_AUTH_TOKEN'),
          config.getOrThrow('TWILIO_FROM'),
          config.get('TWILIO_ENDPOINT') ?? undefined,
        ),
      ),
    );
  }
  const smtpUrl = config.get<string>('SMTP_URL');
  if (smtpUrl) {
    registry.bind(
      'email',
      new EmailChannelProvider(
        db,
        new SmtpTransport(smtpUrl, config.get('EMAIL_FROM') ?? 'no-reply@property.example'),
      ),
    );
  }
}
