import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { PropertiesModule } from '../properties/properties.module';
import { PrivacyController } from './privacy.controller';
import {
  IdpAdminPort,
  JOB_DSR_ESCALATION,
  JOB_GRANT_REVOKE,
  JOB_RETENTION_SWEEP,
  KmsPort,
  LoggingIdpAdmin,
  LoggingKms,
  PrivacyService,
} from './privacy.service';

@Module({
  imports: [ContactsModule, PropertiesModule],
  providers: [
    PrivacyService,
    { provide: IdpAdminPort, useClass: LoggingIdpAdmin },
    { provide: KmsPort, useClass: LoggingKms },
  ],
  controllers: [PrivacyController],
  exports: [PrivacyService],
})
export class PrivacyModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly privacy: PrivacyService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_DSR_ESCALATION, (p) =>
      this.privacy.escalateDsr((p as { dsrId: string }).dsrId),
    );
    this.registry.register(JOB_GRANT_REVOKE, async () => {
      await this.privacy.revokeExpiredGrants();
    });
    this.registry.register(JOB_RETENTION_SWEEP, async () => {
      await this.privacy.runRetentionSweep();
    });
  }
}
