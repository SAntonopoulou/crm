import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { OutboxRelay } from '../../shared/outbox/outbox-relay';
import {
  JOB_RELAY_TICK,
  JOB_WEBHOOK_RETRY,
  WebhookPublisher,
} from './webhook.publisher';

@Module({
  providers: [WebhookPublisher],
  exports: [WebhookPublisher],
})
export class WebhooksModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly relay: OutboxRelay,
    private readonly publisher: WebhookPublisher,
  ) {}

  onModuleInit(): void {
    // The relay now has a real destination; the tick drains one batch.
    this.relay.bind(this.publisher);
    this.registry.register(JOB_RELAY_TICK, async () => {
      await this.relay.runOnce(100);
    });
    this.registry.register(JOB_WEBHOOK_RETRY, (p) =>
      this.publisher.retry((p as { deliveryId: string }).deliveryId),
    );
  }
}
