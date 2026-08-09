import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService, JOB_HOLD_EXPIRE } from './appointments.service';

@Module({
  imports: [ContactsModule, PipelinesModule],
  providers: [AppointmentsService],
  controllers: [AppointmentsController],
  exports: [AppointmentsService],
})
export class AppointmentsModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly appointments: AppointmentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_HOLD_EXPIRE, (payload) =>
      this.appointments.expireHold((payload as { holdId: string }).holdId),
    );
  }
}
