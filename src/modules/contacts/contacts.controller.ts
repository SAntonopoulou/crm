import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { ContactsService } from './contacts.service';

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  display_name?: string;

  @IsOptional()
  @IsIn(['fr', 'nl', 'en'])
  locale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

@Controller('me')
export class MeController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  async getMe(@Req() req: AuthedRequest) {
    const contactId = await this.contacts.resolveOrProvision(req.auth!.sub);
    return this.contacts.getSelf(contactId);
  }

  @Patch()
  async updateMe(@Req() req: AuthedRequest, @Body() body: UpdateMeDto) {
    const contactId = await this.contacts.resolveOrProvision(req.auth!.sub);
    return this.contacts.updateSelf(contactId, body);
  }
}
