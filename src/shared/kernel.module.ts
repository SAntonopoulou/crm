import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AuditLog } from './audit/audit-log.service';
import { Clock, SystemClock } from './jobs/clock';
import { BullJobScheduler, JobRegistry, JobScheduler } from './jobs/job-scheduler';
import { OutboxRelay } from './outbox/outbox-relay';
import { ProvenanceResolver } from './provenance/provenance-resolver';

@Global()
@Module({
  providers: [
    AuditLog,
    ProvenanceResolver,
    OutboxRelay,
    JobRegistry,
    { provide: Clock, useClass: SystemClock },
    {
      provide: JobScheduler,
      inject: [ConfigService, Clock],
      useFactory: (config: ConfigService, clock: Clock): JobScheduler => {
        const queue = new Queue('crm-jobs', {
          connection: {
            url: config.getOrThrow<string>('REDIS_URL'),
            lazyConnect: true,
          },
        });
        return new BullJobScheduler(queue, clock);
      },
    },
  ],
  exports: [AuditLog, ProvenanceResolver, OutboxRelay, JobRegistry, Clock, JobScheduler],
})
export class KernelModule {}
