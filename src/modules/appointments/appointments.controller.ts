import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { ContactsService } from '../contacts/contacts.service';
import { AppointmentsService } from './appointments.service';

export class CreateHoldDto {
  @IsUUID()
  listing_id!: string;

  @IsDateString()
  starts_at!: string;

  @IsDateString()
  ends_at!: string;
}

export class BookAppointmentDto {
  @IsUUID()
  hold_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CancelDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AttendanceDto {
  @IsIn(['geofence', 'one_time_code'])
  method!: 'geofence' | 'one_time_code';

  @IsOptional()
  @IsObject()
  location?: { lat: number; lng: number };

  @IsOptional()
  @IsString()
  code?: string;
}

export class FeedbackDto {
  @IsOptional()
  @IsNumber()
  condition_rating?: number;

  @IsOptional()
  @IsIn(['under', 'fair', 'over'])
  price_opinion?: string;

  @IsOptional()
  @IsIn(['none', 'low', 'medium', 'high'])
  interest_level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comments?: string;

  @IsOptional()
  share_with_owner?: boolean;
}

export class OutcomeDto {
  @IsIn(['interested', 'offer_intent', 'rejected', 'no_show_viewer'])
  outcome!: 'interested' | 'offer_intent' | 'rejected' | 'no_show_viewer';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

@Controller()
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly contacts: ContactsService,
  ) {}

  private contactId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Get('listings/:listingId/viewing-slots')
  async slots(
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.appointments.viewingSlots(
      listingId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Post('appointments/holds')
  @HttpCode(201)
  async hold(@Req() req: AuthedRequest, @Body() body: CreateHoldDto) {
    return this.appointments.placeHold(
      await this.contactId(req),
      body.listing_id,
      new Date(body.starts_at),
      new Date(body.ends_at),
    );
  }

  @Post('appointments')
  @HttpCode(201)
  async book(@Req() req: AuthedRequest, @Body() body: BookAppointmentDto) {
    return this.appointments.book(await this.contactId(req), body.hold_id, body.notes);
  }

  @Get('appointments')
  async list(@Req() req: AuthedRequest) {
    return { items: await this.appointments.listForContact(await this.contactId(req)) };
  }

  @Get('appointments/:appointmentId')
  async detail(@Param('appointmentId', ParseUUIDPipe) appointmentId: string) {
    return this.appointments.getAppointment(appointmentId);
  }

  @Post('appointments/:appointmentId/cancel')
  async cancel(
    @Req() req: AuthedRequest,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: CancelDto,
  ) {
    const contactId = await this.contactId(req);
    const current = (await this.appointments.getAppointment(appointmentId)) as {
      agent?: { contact_id: string };
    };
    if (current.agent?.contact_id === contactId) {
      // The assigned agent backing out is a withdrawal, not a cancellation:
      // the viewer keeps the slot and dispatch finds a replacement.
      await this.appointments.scheduleAgentWithdrawal(appointmentId);
      return {
        appointment: await this.appointments.getAppointment(appointmentId),
        penalty_applied: false,
      };
    }
    await this.appointments.transition(appointmentId, 'cancelled', {
      byParty: 'viewer',
      reason: body.reason,
      actorId: contactId,
    });
    const appointment = await this.appointments.getAppointment(appointmentId);
    return { appointment, penalty_applied: (appointment as { penalty_applied?: boolean }).penalty_applied ?? false };
  }

  @Post('appointments/:appointmentId/register')
  @HttpCode(201)
  async registerOpenHouse(
    @Req() req: AuthedRequest,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
  ) {
    return this.appointments.registerForOpenHouse(
      appointmentId,
      await this.contactId(req),
    );
  }

  @Post('appointments/:appointmentId/unregister')
  @HttpCode(204)
  async unregisterOpenHouse(
    @Req() req: AuthedRequest,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
  ) {
    await this.appointments.unregisterFromOpenHouse(
      appointmentId,
      await this.contactId(req),
    );
  }

  @Post('appointments/:appointmentId/check-in')
  @HttpCode(204)
  async checkIn(
    @Req() req: AuthedRequest,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: AttendanceDto,
  ) {
    const contactId = await this.contactId(req);
    const appointment = (await this.appointments.getAppointment(appointmentId)) as {
      agent?: { contact_id: string };
    };
    const party = appointment.agent?.contact_id === contactId ? 'agent' : 'viewer';
    await this.appointments.recordAttendance(appointmentId, party, 'check_in', body);
  }

  @Post('appointments/:appointmentId/check-out')
  @HttpCode(204)
  async checkOut(
    @Req() req: AuthedRequest,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: AttendanceDto,
  ) {
    const contactId = await this.contactId(req);
    const appointment = (await this.appointments.getAppointment(appointmentId)) as {
      agent?: { contact_id: string };
    };
    const party = appointment.agent?.contact_id === contactId ? 'agent' : 'viewer';
    await this.appointments.recordAttendance(appointmentId, party, 'check_out', body);
  }

  @Post('appointments/:appointmentId/feedback')
  @HttpCode(204)
  async feedback(
    @Req() req: AuthedRequest,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: FeedbackDto,
  ) {
    const contactId = await this.contactId(req);
    const appointment = (await this.appointments.getAppointment(appointmentId)) as {
      agent?: { contact_id: string };
    };
    const role = appointment.agent?.contact_id === contactId ? 'agent' : 'viewer';
    const { share_with_owner, ...structured } = body;
    await this.appointments.recordFeedback(
      appointmentId,
      role,
      structured as Record<string, unknown>,
      share_with_owner ?? false,
    );
  }

  @Post('appointments/:appointmentId/outcome')
  @HttpCode(204)
  async outcome(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body() body: OutcomeDto,
  ) {
    await this.appointments.recordOutcome(appointmentId, body.outcome, body.notes);
  }
}
