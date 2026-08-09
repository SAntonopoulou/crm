import {
  BadRequestException,
  Body,
  Controller,
  Get,
  GoneException,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsInt, IsString, MaxLength, Min } from 'class-validator';
import { sql } from 'kysely';
import { Public, AuthedRequest } from '../../shared/auth/auth.guard';
import { Roles } from '../../shared/auth/roles.guard';
import { compareVersions } from '../../shared/auth/version-gate.middleware';
import { Clock } from '../../shared/jobs/clock';
import { Db } from '../../shared/database/db.service';
import { ContactsService } from '../contacts/contacts.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { MediaService } from './media.service';
import { SyncService } from './sync.service';

/** Server-driven copy, per locale (contract: bootstrap.copy). */
const COPY: Record<string, Record<string, string>> = {
  en: {
    offer_screen_terms: 'By claiming you accept the assignment terms (v1) and the 30-day exclusivity window.',
    upgrade_required: 'This version of the app is no longer supported. Please update.',
  },
  fr: {
    offer_screen_terms: "En acceptant, vous adhérez aux conditions de mission (v1) et à la fenêtre d'exclusivité de 30 jours.",
    upgrade_required: "Cette version de l'application n'est plus prise en charge. Veuillez la mettre à jour.",
  },
  nl: {
    offer_screen_terms: 'Door te claimen aanvaardt u de opdrachtvoorwaarden (v1) en de exclusiviteitsperiode van 30 dagen.',
    upgrade_required: 'Deze versie van de app wordt niet meer ondersteund. Werk de app bij.',
  },
};

export class CreateUploadDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MaxLength(128)
  content_type!: string;

  @IsInt()
  @Min(1)
  size_bytes!: number;

  @IsIn(['listing_media', 'agent_document', 'property_document'])
  purpose!: 'listing_media' | 'agent_document' | 'property_document';
}

@Controller()
export class PlatformController {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly config: ConfigService,
    private readonly contacts: ContactsService,
    private readonly syncService: SyncService,
    private readonly media: MediaService,
    private readonly appointments: AppointmentsService,
  ) {}

  private contactId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────

  @Get('bootstrap')
  async bootstrap(@Req() req: AuthedRequest) {
    const contactId = await this.contactId(req);
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .select('locale')
      .where('id', '=', contactId)
      .executeTakeFirstOrThrow();

    const platform = String(req.headers['x-app-platform'] ?? '').toUpperCase();
    const version = String(req.headers['x-app-version'] ?? '');
    let status: 'ok' | 'upgrade_advised' | 'upgrade_required' = 'ok';
    if (platform && version) {
      const min = this.config.get<string>(`APP_MIN_VERSION_${platform}`);
      const warn = this.config.get<string>(`APP_WARN_VERSION_${platform}`);
      if (min && compareVersions(version, min) < 0) status = 'upgrade_required';
      else if (warn && compareVersions(version, warn) < 0) status = 'upgrade_advised';
    }

    let flags: Record<string, unknown> = {};
    try {
      flags = JSON.parse(this.config.get<string>('BOOTSTRAP_FLAGS') ?? '{}');
    } catch {
      flags = {};
    }

    const entitlements: string[] = [];
    const roles = req.auth?.roles ?? [];
    const contactRoles = await this.db.kysely
      .selectFrom('core.contact_role')
      .select('role')
      .where('contact_id', '=', contactId)
      .where('state', '=', 'active')
      .execute();
    const roleSet = new Set([...roles, ...contactRoles.map((r) => r.role)]);
    if (roleSet.has('agent')) entitlements.push('agent_offers');
    if (roleSet.has('owner')) entitlements.push('owner_listings');
    if (roleSet.has('staff')) entitlements.push('staff_ops');

    return {
      version_verdict: { status, message_key: status === 'ok' ? undefined : 'upgrade_required' },
      flags,
      copy: COPY[contact.locale] ?? COPY.en,
      entitlements,
    };
  }

  // ── Delta sync ─────────────────────────────────────────────────────

  @Get('sync')
  async sync(
    @Req() req: AuthedRequest,
    @Query('since') since?: string,
    @Query('types') types?: string,
    @Query('limit') limit?: string,
  ) {
    if (since === undefined || since === '' || Number.isNaN(Number(since))) {
      throw new BadRequestException({ code: 'since_required' });
    }
    return this.syncService.sync(
      await this.contactId(req),
      Number(since),
      types
        ? (types.split(',').map((t) => t.trim()) as Parameters<SyncService['sync']>[2])
        : undefined,
      Math.min(Number(limit) || 100, 100),
    );
  }

  // ── Agent schedule + iCal ──────────────────────────────────────────

  @Get('agent/schedule')
  @Roles('agent')
  async schedule(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const agentId = await this.contactId(req);
    const windowFrom = from ? new Date(from) : this.clock.now();
    const windowTo = to
      ? new Date(to)
      : new Date(windowFrom.getTime() + 14 * 24 * 3_600_000);

    const rows = await this.db.kysely
      .selectFrom('core.appointment')
      .select('id')
      .where('agent_id', '=', agentId)
      .where('state', 'in', ['booked', 'confirmed', 'in_progress'])
      .where(sql<boolean>`during && tstzrange(${windowFrom}, ${windowTo})`)
      .orderBy(sql`lower(during)`)
      .execute();
    const items = [];
    for (const row of rows) items.push(await this.appointments.getAppointment(row.id));

    const profile = await this.db.kysely
      .selectFrom('core.agent_profile')
      .select('ical_token')
      .where('contact_id', '=', agentId)
      .executeTakeFirst();
    if (!profile) throw new NotFoundException({ code: 'agent_not_found' });

    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:3000';
    return {
      appointments: items,
      ical_url: `${base}/v1/calendar/${profile.ical_token}.ics`,
    };
  }

  /** Tokenised read-only feed — the token IS the credential. */
  @Public()
  @Get('calendar/:token.ics')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  async ical(@Param('token') token: string): Promise<string> {
    const agent = await this.db.kysely
      .selectFrom('core.agent_profile')
      .select('contact_id')
      .where('ical_token', '=', token)
      .executeTakeFirst();
    if (!agent) throw new NotFoundException();

    const rows = await this.db.kysely
      .selectFrom('core.appointment as a')
      .innerJoin('core.property as p', 'p.id', 'a.property_id')
      .select([
        'a.id', 'a.state',
        sql<Date>`lower(a.during)`.as('starts_at'),
        sql<Date>`upper(a.during)`.as('ends_at'),
        sql<string | null>`p.address_normalised->>'city'`.as('city'),
        sql<string | null>`p.address_normalised->>'postcode'`.as('postcode'),
      ])
      .where('a.agent_id', '=', agent.contact_id)
      .where('a.state', 'in', ['booked', 'confirmed', 'in_progress'])
      .where(sql<boolean>`upper(a.during) > now() - interval '1 day'`)
      .orderBy(sql`lower(a.during)`)
      .execute();

    const stamp = (d: Date) =>
      d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const events = rows
      .map((r) =>
        [
          'BEGIN:VEVENT',
          `UID:${r.id}@crm`,
          `DTSTART:${stamp(r.starts_at)}`,
          `DTEND:${stamp(r.ends_at)}`,
          // Address stays coarse: full details live behind the access grant.
          `SUMMARY:Viewing (${r.state}) — ${[r.postcode, r.city].filter(Boolean).join(' ')}`,
          'END:VEVENT',
        ].join('\r\n'),
      )
      .join('\r\n');
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//property-crm//agent-schedule//EN',
      events,
      'END:VCALENDAR',
      '',
    ].join('\r\n');
  }

  // ── Media uploads ──────────────────────────────────────────────────

  @Post('media/uploads')
  @HttpCode(201)
  async startUpload(@Req() req: AuthedRequest, @Body() body: CreateUploadDto) {
    return this.media.createSession(await this.contactId(req), body);
  }

  @Put('media/uploads/:sessionId/content')
  @HttpCode(204)
  async uploadContent(
    @Req() req: AuthedRequest & NodeJS.ReadableStream,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    const contactId = await this.contactId(req);
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const result = await this.media.storeContent(
      contactId,
      sessionId,
      Buffer.concat(chunks),
    );
    if (result === 'expired') throw new GoneException({ code: 'upload_expired' });
  }
}
