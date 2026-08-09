import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import {
  GeocoderPort,
  GeocodingService,
  JOB_GEOCODE,
  NoopGeocoder,
} from './geocoder.service';
import { IngestService } from './ingest.service';
import { PropertiesService } from './properties.service';
import { IngestController, ListingsController } from './properties.controllers';
import { SuppressionService } from './suppression.service';

@Module({
  imports: [ContactsModule],
  providers: [
    PropertiesService,
    IngestService,
    SuppressionService,
    GeocodingService,
    { provide: GeocoderPort, useClass: NoopGeocoder },
  ],
  controllers: [IngestController, ListingsController],
  exports: [PropertiesService, SuppressionService, IngestService],
})
export class PropertiesModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly geocoding: GeocodingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(JOB_GEOCODE, async (p) => {
      await this.geocoding.geocodeProperty((p as { propertyId: string }).propertyId);
    });
  }
}
