import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { ContactsService } from '../contacts/contacts.service';
import { MatchingService } from './matching.service';
import { ProfileInput, ProfilesService } from './profiles.service';

export class MatchFeedbackDto {
  @IsIn(['dismissed', 'interested'])
  feedback!: 'dismissed' | 'interested';
}

@Controller()
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly matching: MatchingService,
    private readonly contacts: ContactsService,
  ) {}

  private contactId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Get('me/requirement-profiles')
  async list(@Req() req: AuthedRequest) {
    return this.profiles.list(await this.contactId(req));
  }

  @Post('me/requirement-profiles')
  @HttpCode(201)
  async create(@Req() req: AuthedRequest, @Body() body: ProfileInput) {
    return this.profiles.create(await this.contactId(req), body);
  }

  @Patch('me/requirement-profiles/:profileId')
  async update(
    @Req() req: AuthedRequest,
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() body: ProfileInput,
  ) {
    return this.profiles.update(await this.contactId(req), profileId, body);
  }

  @Post('matches/:matchId/feedback')
  @HttpCode(204)
  async feedback(
    @Req() req: AuthedRequest,
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @Body() body: MatchFeedbackDto,
  ) {
    await this.matching.recordFeedback(matchId, await this.contactId(req), body.feedback);
  }
}
