import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { ConversationsController } from './comms.controller';
import {
  CommsService,
  JOB_SEQUENCE_STEP,
  MessageProviderRegistry,
} from './comms.service';

@Module({
  imports: [ContactsModule, PipelinesModule],
  providers: [CommsService, MessageProviderRegistry],
  controllers: [ConversationsController],
  exports: [CommsService],
})
export class CommsModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly comms: CommsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_SEQUENCE_STEP, (p) =>
      this.comms.runSequenceStep((p as { enrollmentId: string }).enrollmentId),
    );
  }
}
