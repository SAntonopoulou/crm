import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { PropertiesModule } from '../properties/properties.module';
import { OpsActionsController } from './ops-actions.controller';
import { OpsController } from './reporting.controller';
import { ReportingService } from './reporting.service';

@Module({
  imports: [ContactsModule, PropertiesModule, DispatchModule, PrivacyModule, AgentsModule],
  providers: [ReportingService],
  controllers: [OpsController, OpsActionsController],
})
export class ReportingModule {}
