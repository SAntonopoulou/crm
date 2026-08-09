import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { NominatimGeocoder } from './nominatim.adapter';
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
    {
      // Nominatim-compatible geocoder when configured; no-op otherwise.
      provide: GeocoderPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService): GeocoderPort =>
        config.get('GEOCODER_URL') ? new NominatimGeocoder(config) : new NoopGeocoder(),
    },
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
