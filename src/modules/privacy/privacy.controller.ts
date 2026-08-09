import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { ContactsService } from '../contacts/contacts.service';
import { PrivacyService } from './privacy.service';

export class CreateDsrDto {
  @IsIn(['access', 'rectification', 'erasure', 'restriction', 'portability', 'objection'])
  kind!: 'access' | 'rectification' | 'erasure' | 'restriction' | 'portability' | 'objection';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  detail?: string;
}

@Controller('me')
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly contacts: ContactsService,
  ) {}

  private contactId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Post('dsr')
  @HttpCode(201)
  async fileDsr(@Req() req: AuthedRequest, @Body() body: CreateDsrDto) {
    return this.privacy.fileDsr(await this.contactId(req), body.kind, body.detail);
  }

  @Get('dsr/:dsrId')
  async getDsr(
    @Req() req: AuthedRequest,
    @Param('dsrId', ParseUUIDPipe) dsrId: string,
  ) {
    return this.privacy.getDsr(await this.contactId(req), dsrId);
  }

  @Get('dsr/:dsrId/download')
  async downloadExport(
    @Req() req: AuthedRequest,
    @Param('dsrId', ParseUUIDPipe) dsrId: string,
  ) {
    const data = await this.privacy.downloadExport(await this.contactId(req), dsrId);
    return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  }

  @Get('consents')
  async listConsents(@Req() req: AuthedRequest) {
    return this.privacy.listConsents(await this.contactId(req));
  }

  @Post('consents/:purpose/withdraw')
  @HttpCode(204)
  async withdrawConsent(
    @Req() req: AuthedRequest,
    @Param('purpose') purpose: string,
  ) {
    await this.privacy.withdrawConsent(await this.contactId(req), purpose);
  }
}
