import { ConfigService } from '@nestjs/config';
import { Db } from '../../shared/database/db.service';
import { SmtpTransport, TwilioTransport } from '../../shared/messaging/transports';
import { MessageProvider, MessageProviderRegistry } from './comms.service';

class SmtpMessageProvider implements MessageProvider {
  constructor(
    private readonly db: Db,
    private readonly smtp: SmtpTransport,
  ) {}

  async deliver(input: {
    toContactId: string;
    body: string;
  }): Promise<{ providerMessageId?: string } | 'failed'> {
    const email = await recipient(this.db, input.toContactId, 'email');
    if (!email) return 'failed';
    try {
      const id = await this.smtp.send(email, 'Property Platform', input.body);
      return { providerMessageId: id };
    } catch {
      return 'failed';
    }
  }
}

class TwilioMessageProvider implements MessageProvider {
  constructor(
    private readonly db: Db,
    private readonly twilio: TwilioTransport,
  ) {}

  async deliver(input: {
    toContactId: string;
    body: string;
  }): Promise<{ providerMessageId?: string } | 'failed'> {
    const phone = await recipient(this.db, input.toContactId, 'phone');
    if (!phone) return 'failed';
    const result = await this.twilio.send(phone, input.body);
    return result === 'failed' ? 'failed' : { providerMessageId: result.sid };
  }
}

async function recipient(
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

/** Bind the outbound message providers iff configured (comms-only file:
 *  the compliance gate remains the single send path). */
export function bindMessageProviders(
  registry: MessageProviderRegistry,
  db: Db,
  config: ConfigService,
): void {
  const smtpUrl = config.get<string>('SMTP_URL');
  if (smtpUrl) {
    registry.bind(
      'email',
      new SmtpMessageProvider(
        db,
        new SmtpTransport(smtpUrl, config.get('EMAIL_FROM') ?? 'no-reply@property.example'),
      ),
    );
  }
  const twilioSid = config.get<string>('TWILIO_ACCOUNT_SID');
  if (twilioSid) {
    registry.bind(
      'sms',
      new TwilioMessageProvider(
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
}
