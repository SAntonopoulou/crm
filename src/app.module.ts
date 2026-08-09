import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from './health.controller';
import { DatabaseModule } from './shared/database/database.module';
import { KernelModule } from './shared/kernel.module';
import { AuthModule } from './shared/auth/auth.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AgentsModule } from './modules/agents/agents.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { CommsModule } from './modules/comms/comms.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { PlatformModule } from './modules/platform/platform.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { WorkerModule } from './modules/worker/worker.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { PiiAccessInterceptor } from './shared/audit/pii-access.interceptor';
import { VersionGateMiddleware } from './shared/auth/version-gate.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    KernelModule,
    AuthModule,
    ContactsModule,
    PropertiesModule,
    PortfolioModule,
    PipelinesModule,
    AppointmentsModule,
    AgentsModule,
    DispatchModule,
    NotificationsModule,
    CommsModule,
    PrivacyModule,
    ReportingModule,
    PlatformModule,
    WebhooksModule,
    WorkerModule,
    CalendarModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: PiiAccessInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(VersionGateMiddleware).forRoutes('{*path}');
  }
}
