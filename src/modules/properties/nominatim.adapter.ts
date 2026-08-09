import { ConfigService } from '@nestjs/config';
import { GeocoderPort, GeocodeResult } from './geocoder.service';
import { NormalisedAddress } from './normalise';

/**
 * Nominatim-compatible geocoder (self-hosted for production — the vendor
 * goes in privacy.processor; the public OSM instance is dev-only under
 * its usage policy). Selected when GEOCODER_URL is configured.
 */
export class NominatimGeocoder extends GeocoderPort {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    super();
    this.baseUrl = config.getOrThrow<string>('GEOCODER_URL').replace(/\/$/, '');
  }

  async geocode(address: NormalisedAddress): Promise<GeocodeResult | null> {
    const params = new URLSearchParams({
      format: 'jsonv2',
      limit: '1',
      street: [address.number, address.street].filter(Boolean).join(' '),
      city: address.city ?? '',
      postalcode: address.postcode ?? '',
      country: address.country ?? '',
    });
    const response = await fetch(`${this.baseUrl}/search?${params}`, {
      headers: { 'user-agent': 'property-crm/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const results = (await response.json()) as {
      lat: string;
      lon: string;
      importance?: number;
    }[];
    if (results.length === 0) return null;
    const hit = results[0];
    return {
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      timezone: 'Europe/Brussels', // single-market platform; adapter-level default
      confidence: Math.min(1, Math.max(0.1, hit.importance ?? 0.5)),
    };
  }
}
