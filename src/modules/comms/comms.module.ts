import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db } from '../../shared/database/db.service';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { ConversationsController } from './comms.controller';
import { bindMessageProviders } from './message-providers.adapter';
import {
  CommsService,
  JOB_SEQUENCE_STEP,
  MessageProviderRegistry,
} from './comms.service';
import { TemplatesService } from './templates.service';

@Module({
  imports: [ContactsModule, PipelinesModule],
  providers: [CommsService, MessageProviderRegistry, TemplatesService],
  controllers: [ConversationsController],
  exports: [CommsService, TemplatesService],
})
export class CommsModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly comms: CommsService,
    private readonly providers: MessageProviderRegistry,
    private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Real SMTP/Twilio message providers bind iff configured — inside the
    // comms module only, so the compliance gate stays the single send path.
    bindMessageProviders(this.providers, this.db, this.config);
    this.registry.register(JOB_SEQUENCE_STEP, (p) =>
      this.comms.runSequenceStep((p as { enrollmentId: string }).enrollmentId),
    );
  }
}
