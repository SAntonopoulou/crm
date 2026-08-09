import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { ContactsService } from '../contacts/contacts.service';
import { NotificationsService } from './notifications.service';

export class DeviceInputDto {
  @IsOptional()
  @IsString()
  push_token?: string | null;

  @IsIn(['ios', 'android', 'web'])
  platform!: 'ios' | 'android' | 'web';

  @IsOptional()
  @IsString()
  @MaxLength(32)
  app_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;

  @IsOptional()
  @IsIn(['granted', 'denied', 'provisional', 'undetermined'])
  os_permission_state?: string;
}

@Controller()
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly contacts: ContactsService,
  ) {}

  private contactId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Put('devices/:installId')
  @HttpCode(204)
  async registerDevice(
    @Req() req: AuthedRequest,
    @Param('installId') installId: string,
    @Body() body: DeviceInputDto,
  ) {
    await this.notifications.registerDevice(await this.contactId(req), installId, body);
  }

  @Delete('devices/:installId')
  @HttpCode(204)
  async removeDevice(@Req() req: AuthedRequest, @Param('installId') installId: string) {
    await this.notifications.removeDevice(await this.contactId(req), installId);
  }

  @Post('notifications/:notificationId/ack')
  @HttpCode(204)
  async ack(
    @Req() req: AuthedRequest,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ) {
    await this.notifications.acknowledge(notificationId, await this.contactId(req));
  }

  @Get('me/preferences')
  async getPreferences(@Req() req: AuthedRequest) {
    return this.notifications.getPreferences(await this.contactId(req));
  }

  @Put('me/preferences')
  async putPreferences(
    @Req() req: AuthedRequest,
    @Body() body: {
      channel: 'push' | 'sms' | 'email';
      category: 'transactional' | 'marketing';
      device_install_id?: string | null;
      opted_out: boolean;
    }[],
  ) {
    return this.notifications.putPreferences(await this.contactId(req), body ?? []);
  }
}
