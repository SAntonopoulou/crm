import {
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { JobRegistry } from '../../shared/jobs/job-scheduler';

/**
 * The production job runtime. Gated behind JOBS_ENABLED=true so API-only
 * replicas and tests never consume queues. All repeatable schedules from
 * the runbook are registered here; one-off delayed jobs arrive via the
 * kernel's BullJobScheduler on the same queue.
 */
@Injectable()
export class JobsRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsRuntime.name);
  private worker?: Worker;
  private queue?: Queue;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: JobRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('JOBS_ENABLED') !== 'true') return;
    const connection = {
      url: this.config.getOrThrow<string>('REDIS_URL'),
    };
    const queueName = this.config.get<string>('JOBS_QUEUE_NAME') ?? 'crm-jobs';

    this.queue = new Queue(queueName, { connection });
    this.worker = new Worker(
      queueName,
      async (job) => {
        await this.registry.get(job.name)(job.data);
      },
      { connection, concurrency: 8 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`job ${job?.name} (${job?.id}) failed: ${err.message}`),
    );

    // Runbook §2 schedules (Europe/Brussels where wall-clock matters).
    const repeatables: [string, { pattern?: string; every?: number }][] = [
      ['outbox.relay_tick', { every: 10_000 }],
      ['privacy.grant_revoke', { every: 300_000 }],
      ['privacy.retention_sweep', { pattern: '0 3 * * *' }],
      ['agents.doc_lapse_check', { pattern: '0 6 * * *' }],
      ['agents.scorecard_refresh', { pattern: '30 * * * *' }],
      ['portfolio.revalue', { pattern: '0 * * * *' }],
    ];
    for (const [name, repeat] of repeatables) {
      await this.queue.upsertJobScheduler(
        `sched:${name}`,
        { ...repeat, tz: 'Europe/Brussels' },
        { name, data: {} },
      );
    }
    this.logger.log(
      `job runtime up: queue=${queueName}, ${repeatables.length} schedules`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

@Module({
  providers: [JobsRuntime],
})
export class WorkerModule {}
