import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../../shared/database/db.service';
import { NormalisedAddress } from './normalise';

export const JOB_GEOCODE = 'properties.geocode';

export interface GeocodeResult {
  lat: number;
  lng: number;
  timezone?: string;
  confidence: number;
}

/**
 * Geocoding seam. The production adapter must be an EU-hosted provider (or
 * on SCCs) and registered in privacy.processor — addresses tied to owners
 * are personal data (risk register item 5). The canonical property key is
 * deliberately NOT derived from geocoder output, so adapters are swappable.
 */
export abstract class GeocoderPort {
  abstract geocode(address: NormalisedAddress): Promise<GeocodeResult | null>;
}

/** Safe default: no coordinates until an adapter is configured. */
export class NoopGeocoder extends GeocoderPort {
  async geocode(): Promise<GeocodeResult | null> {
    return null;
  }
}

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(
    private readonly db: Db,
    private readonly geocoder: GeocoderPort,
  ) {}

  /** Job handler: fill in geo for a property that has none. Idempotent. */
  async geocodeProperty(propertyId: string): Promise<boolean> {
    const property = await this.db.kysely
      .selectFrom('core.property')
      .select([
        'id',
        'address_normalised',
        sql<boolean>`geo_point IS NOT NULL`.as('has_geo'),
      ])
      .where('id', '=', propertyId)
      .executeTakeFirst();
    if (!property || property.has_geo) return false;

    const result = await this.geocoder.geocode(
      property.address_normalised as unknown as NormalisedAddress,
    );
    if (!result) return false;

    await this.db.kysely
      .updateTable('core.property')
      .set({
        geo_point: sql`ST_SetSRID(ST_MakePoint(${result.lng}, ${result.lat}), 4326)::geography`,
        ...(result.timezone ? { timezone: result.timezone } : {}),
      })
      .where('id', '=', propertyId)
      .execute();
    this.logger.debug(`geocoded property ${propertyId} (confidence ${result.confidence})`);
    return true;
  }
}
