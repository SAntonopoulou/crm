import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import {
  CalendarService,
  CalendarSyncPort,
  JOB_CALENDAR_IMPORT,
  JOB_CALENDAR_IMPORT_ALL,
  JOB_CALENDAR_PUSH,
  JOB_CALENDAR_REMOVE,
  NoopCalendarSync,
} from './calendar.service';

@Module({
  providers: [CalendarService, { provide: CalendarSyncPort, useClass: NoopCalendarSync }],
  exports: [CalendarService],
})
export class CalendarModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly calendar: CalendarService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_CALENDAR_PUSH, (p) => {
      const payload = p as { appointmentId: string; agentId: string };
      return this.calendar.pushAppointment(payload.appointmentId, payload.agentId);
    });
    this.registry.register(JOB_CALENDAR_REMOVE, (p) =>
      this.calendar.removeAppointment((p as { appointmentId: string }).appointmentId),
    );
    this.registry.register(JOB_CALENDAR_IMPORT, async (p) => {
      await this.calendar.importBusy((p as { calendarLinkId: string }).calendarLinkId);
    });
    this.registry.register(JOB_CALENDAR_IMPORT_ALL, () => this.calendar.importAll());
  }
}
