import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../../shared/auth/roles.guard';
import { IngestBatchInput, IngestService } from './ingest.service';
import { PropertiesService } from './properties.service';

@Controller('ingest')
@Roles('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post('batches')
  @HttpCode(202)
  async submitBatch(
    @Body() body: IngestBatchInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException({ code: 'idempotency_key_required' });
    }
    return this.ingest.processBatch(body, idempotencyKey);
  }

  @Get('batches/:batchId')
  async getBatch(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ingest.getBatch(
      batchId,
      cursor,
      Math.min(parseInt(limit ?? '100', 10) || 100, 500),
    );
  }

  @Post('batches/:batchId/replay')
  @HttpCode(202)
  async replay(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.ingest.replayBatch(batchId);
  }
}

@Controller('listings')
export class ListingsController {
  constructor(private readonly properties: PropertiesService) {}

  @Get()
  async search(@Query() query: Record<string, string>) {
    const num = (v?: string) => (v !== undefined && v !== '' ? Number(v) : undefined);
    return this.properties.search({
      channel: query.channel as 'sale' | 'rent' | undefined,
      lat: num(query.lat),
      lng: num(query.lng),
      radius_km: num(query.radius_km),
      postcodes: query.postcodes
        ? query.postcodes.split(',').map((p) => p.trim().toLowerCase())
        : undefined,
      price_min: query.price_min,
      price_max: query.price_max,
      bedrooms_min: num(query.bedrooms_min),
      property_kind: query.property_kind,
      occupancy: query.occupancy,
      cursor: query.cursor,
      limit: Math.min(num(query.limit) ?? 25, 100),
    });
  }

  @Get(':listingId')
  async detail(@Param('listingId', ParseUUIDPipe) listingId: string) {
    return this.properties.getListing(listingId);
  }
}
