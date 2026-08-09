import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { AppointmentsModule } from '../appointments/appointments.module';
import { ContactsModule } from '../contacts/contacts.module';
import { OffersController } from './dispatch.controller';
import {
  DispatchService,
  JOB_DISPATCH_START,
  JOB_OFFER_TTL,
} from './dispatch.service';

@Module({
  imports: [ContactsModule, AppointmentsModule],
  providers: [DispatchService],
  controllers: [OffersController],
  exports: [DispatchService],
})
export class DispatchModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly dispatch: DispatchService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_DISPATCH_START, async (payload) => {
      await this.dispatch.startDispatch(
        (payload as { appointmentId: string }).appointmentId,
      );
    });
    this.registry.register(JOB_OFFER_TTL, (payload) =>
      this.dispatch.expireOffer((payload as { offerId: string }).offerId),
    );
  }
}
