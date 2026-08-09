import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { PlatformModule } from '../platform/platform.module';
import { PropertiesModule } from '../properties/properties.module';
import { ConfigService } from '@nestjs/config';
import { Db } from '../../shared/database/db.service';
import { BreachService, JOB_BREACH_WARNING } from './breach.service';
import { CryptoService, DbEnvelopeKms } from './crypto.service';
import { KeycloakIdpAdmin } from './keycloak-idp.adapter';
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
import { SecurityService } from './security.service';
import { SensitiveDataService } from './sensitive-data.service';

@Module({
  imports: [ContactsModule, PropertiesModule, PlatformModule],
  providers: [
    PrivacyService,
    SecurityService,
    BreachService,
    CryptoService,
    SensitiveDataService,
    {
      // Real Keycloak admin when the client secret is configured.
      provide: IdpAdminPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService): IdpAdminPort =>
        config.get('KEYCLOAK_ADMIN_CLIENT_SECRET')
          ? new KeycloakIdpAdmin(config)
          : new LoggingIdpAdmin(),
    },
    {
      // Real crypto-shredding when the master key is configured.
      provide: KmsPort,
      inject: [ConfigService, Db],
      useFactory: (config: ConfigService, db: Db): KmsPort =>
        config.get('KMS_MASTER_KEY') ? new DbEnvelopeKms(db) : new LoggingKms(),
    },
  ],
  controllers: [PrivacyController],
  exports: [PrivacyService, SecurityService, BreachService, SensitiveDataService, CryptoService],
})
export class PrivacyModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly privacy: PrivacyService,
    private readonly breach: BreachService,
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
    this.registry.register(JOB_BREACH_WARNING, (p) =>
      this.breach.deadlineWarning((p as { incidentId: string }).incidentId),
    );
  }
}
