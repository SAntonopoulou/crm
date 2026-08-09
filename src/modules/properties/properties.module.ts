import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { IngestService } from './ingest.service';
import { PropertiesService } from './properties.service';
import { IngestController, ListingsController } from './properties.controllers';
import { SuppressionService } from './suppression.service';

@Module({
  imports: [ContactsModule],
  providers: [PropertiesService, IngestService, SuppressionService],
  controllers: [IngestController, ListingsController],
  exports: [PropertiesService, SuppressionService],
})
export class PropertiesModule {}
