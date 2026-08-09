import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { IsArray, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { Roles } from '../../shared/auth/roles.guard';
import { ContactsService } from '../contacts/contacts.service';
import { AgentsService } from './agents.service';

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
}
