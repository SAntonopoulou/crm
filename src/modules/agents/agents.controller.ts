import {
  Body,
  ConflictException,
  Controller,
  Get,
  Patch,
  Put,
  Req,
} from '@nestjs/common';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { Roles } from '../../shared/auth/roles.guard';
import { StepUp } from '../../shared/auth/step-up.guard';
import { ContactsService } from '../contacts/contacts.service';
import { SecurityService } from '../privacy/security.service';
import { SensitiveDataService } from '../privacy/sensitive-data.service';
import { AgentsService } from './agents.service';

export class PayoutDetailsDto {
  @IsString()
  @Matches(/^[A-Z]{2}[0-9]{2}[A-Z0-9\s]{10,30}$/i, { message: 'iban format invalid' })
  iban!: string;
}

export class AgentProfileUpdateDto {
  @IsOptional()
  @IsArray()
  languages?: string[];

  @IsOptional()
  @IsArray()
  specialisms?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  capacity_max_active?: number;

  @IsOptional()
  @IsObject()
  working_hours?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  coverage?: { polygons?: object; postcodes?: string[] };
}

@Controller('agent/profile')
@Roles('agent')
export class AgentProfileController {
  constructor(
    private readonly agents: AgentsService,
    private readonly contacts: ContactsService,
    private readonly sensitive: SensitiveDataService,
    private readonly security: SecurityService,
  ) {}

  @Get()
  async get(@Req() req: AuthedRequest) {
    return this.agents.getProfile(await this.contacts.resolveOrProvision(req.auth!.sub));
  }

  @Patch()
  async update(@Req() req: AuthedRequest, @Body() body: AgentProfileUpdateDto) {
    return this.agents.updateProfile(
      await this.contacts.resolveOrProvision(req.auth!.sub),
      body,
    );
  }

  /** Field-encrypted payout IBAN. Step-up + post-recovery cooldown gated. */
  @Put('payout-details')
  @StepUp('payout_change')
  async setPayoutDetails(@Req() req: AuthedRequest, @Body() body: PayoutDetailsDto) {
    const contactId = await this.contacts.resolveOrProvision(req.auth!.sub);
    if (!(await this.security.payoutChangeAllowed(contactId))) {
      throw new ConflictException({ code: 'payout_change_locked' });
    }
    await this.sensitive.setIban(contactId, body.iban, contactId);
    return { iban_masked: await this.sensitive.getIbanMasked(contactId) };
  }

  @Get('payout-details')
  async getPayoutDetails(@Req() req: AuthedRequest) {
    const contactId = await this.contacts.resolveOrProvision(req.auth!.sub);
    return { iban_masked: await this.sensitive.getIbanMasked(contactId) };
  }
}
