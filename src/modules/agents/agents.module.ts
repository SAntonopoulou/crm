import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { AgentProfileController } from './agents.controller';
import { AgentsService, JOB_DOC_LAPSE_CHECK } from './agents.service';

@Module({
  imports: [ContactsModule],
  providers: [AgentsService],
  controllers: [AgentProfileController],
  exports: [AgentsService],
})
export class AgentsModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly agents: AgentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_DOC_LAPSE_CHECK, async () => {
      await this.agents.runDocLapseCheck();
    });
  }
}
