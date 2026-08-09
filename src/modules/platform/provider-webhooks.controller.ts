import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { Public } from '../../shared/auth/auth.guard';
import { Db } from '../../shared/database/db.service';

export class ProviderStatusDto {
  @IsString()
  @MaxLength(255)
  provider_message_id!: string;

  @IsIn(['delivered', 'bounced', 'failed', 'complained'])
  status!: 'delivered' | 'bounced' | 'failed' | 'complained';
}

/**
 * Normalized delivery/bounce callback endpoint. Provider-specific webhook
 * shapes (Twilio, SES, …) are translated to this shape at the edge (API
 * gateway or a thin function) so the CRM stays vendor-neutral. Guarded by
 * a shared secret; unmatched provider ids are acknowledged and dropped.
 */
@Controller('webhooks/providers')
export class ProviderWebhooksController {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('status')
  @HttpCode(204)
  async status(
    @Body() body: ProviderStatusDto,
    @Headers('x-webhook-secret') secret?: string,
  ): Promise<void> {
    const expected = this.config.get<string>('PROVIDER_WEBHOOK_SECRET');
    if (!expected || secret !== expected) {
      throw new UnauthorizedException({ code: 'bad_webhook_secret' });
    }

    await this.db.tx(async (ctx) => {
      const message = await ctx.trx
        .updateTable('core.message')
        .set({ state: body.status })
        .where('provider_message_id', '=', body.provider_message_id)
        .returning(['id', 'channel'])
        .executeTakeFirst();
      if (message) {
        await ctx.emit({
          aggregateType: 'message',
          aggregateId: message.id,
          eventType: 'message.delivery_changed',
          payload: { channel: message.channel, state: body.status },
        });
      }
      await ctx.trx
        .updateTable('core.delivery_attempt')
        .set({ state: body.status === 'complained' ? 'bounced' : body.status })
        .where('provider_message_id', '=', body.provider_message_id)
        .execute();
    });
  }
}
