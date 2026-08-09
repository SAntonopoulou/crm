import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db } from '../../shared/database/db.service';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { bindChannelProviders } from './channel-providers.adapter';
import { NotificationsController } from './notifications.controller';
import {
  JOB_NOTIFICATION_DELIVER,
  JOB_NOTIFICATION_ESCALATE,
  JOB_NOTIFY_DISPATCH_OFFER,
  NotificationsService,
  ProviderRegistry,
} from './notifications.service';

@Module({
  imports: [ContactsModule],
  providers: [NotificationsService, ProviderRegistry],
  controllers: [NotificationsController],
  exports: [NotificationsService, ProviderRegistry],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly notifications: NotificationsService,
    private readonly providers: ProviderRegistry,
    private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Real FCM/Twilio/SMTP channel providers bind iff configured.
    bindChannelProviders(this.providers, this.db, this.config);
    this.registry.register(JOB_NOTIFICATION_DELIVER, (p) => {
      const { notificationId, step } = p as { notificationId: string; step: number };
      return this.notifications.deliverStep(notificationId, step);
    });
    this.registry.register(JOB_NOTIFICATION_ESCALATE, (p) => {
      const { notificationId, step } = p as { notificationId: string; step: number };
      return this.notifications.escalate(notificationId, step);
    });
    // Generic seam: any module can request a notification via the job
    // registry without importing this module (dependency direction).
    this.registry.register('notification.send', async (p) => {
      await this.notifications.send(
        p as Parameters<NotificationsService['send']>[0],
      );
    });
    // Dispatch offers are the flagship time-critical message.
    this.registry.register(JOB_NOTIFY_DISPATCH_OFFER, async (p) => {
      const payload = p as { offerId: string; agentId: string; ttlExpiresAt: string };
      await this.notifications.send({
        contactId: payload.agentId,
        category: 'transactional',
        priority: 'critical_ack',
        kind: 'dispatch_offer',
        payload: { offer_id: payload.offerId, ttl_expires_at: payload.ttlExpiresAt },
      });
    });
  }
}
