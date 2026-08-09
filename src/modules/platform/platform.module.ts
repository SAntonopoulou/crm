import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { ContactsModule } from '../contacts/contacts.module';
import { PlatformController } from './platform.controller';
import { LocalDiskStorage, MediaService, StoragePort } from './media.service';
import { SyncService } from './sync.service';

@Module({
  imports: [ContactsModule, AppointmentsModule],
  providers: [
    SyncService,
    MediaService,
    { provide: StoragePort, useClass: LocalDiskStorage },
  ],
  controllers: [PlatformController],
  exports: [SyncService, StoragePort],
})
export class PlatformModule {}
