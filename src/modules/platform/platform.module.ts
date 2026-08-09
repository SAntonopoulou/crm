import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppointmentsModule } from '../appointments/appointments.module';
import { ContactsModule } from '../contacts/contacts.module';
import { PlatformController } from './platform.controller';
import { ProviderWebhooksController } from './provider-webhooks.controller';
import { LocalDiskStorage, MediaService, StoragePort } from './media.service';
import { S3Storage } from './s3-storage.adapter';
import { SyncService } from './sync.service';

@Module({
  imports: [ContactsModule, AppointmentsModule],
  providers: [
    SyncService,
    MediaService,
    {
      // S3-compatible storage when configured; local disk in bare dev.
      provide: StoragePort,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StoragePort =>
        config.get('S3_ENDPOINT') ? new S3Storage(config) : new LocalDiskStorage(config),
    },
  ],
  controllers: [PlatformController, ProviderWebhooksController],
  exports: [SyncService, StoragePort],
})
export class PlatformModule {}
