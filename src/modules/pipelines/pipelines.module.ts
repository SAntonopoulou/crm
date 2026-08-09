import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { MatchingService, JOB_EVALUATE_LISTING } from './matching.service';
import { PipelinesService, JOB_SLA_BREACH, SlaBreachPayload } from './pipelines.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [ContactsModule],
  providers: [PipelinesService, MatchingService, ProfilesService],
  controllers: [ProfilesController],
  exports: [PipelinesService, MatchingService],
})
export class PipelinesModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly pipelines: PipelinesService,
    private readonly matching: MatchingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_SLA_BREACH, (payload) =>
      this.pipelines.handleSlaBreach(payload as SlaBreachPayload),
    );
    this.registry.register(JOB_EVALUATE_LISTING, async (payload) => {
      await this.matching.evaluateListing((payload as { listingId: string }).listingId);
    });
  }
}
