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
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { ContactsService } from '../contacts/contacts.service';
import { CommsService } from './comms.service';

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly comms: CommsService,
    private readonly contacts: ContactsService,
  ) {}

  private contactId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    return { items: await this.comms.listConversations(await this.contactId(req)) };
  }

  @Get(':conversationId/messages')
  async messages(
    @Req() req: AuthedRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return {
      items: await this.comms.listMessages(conversationId, await this.contactId(req)),
    };
  }

  @Post(':conversationId/messages')
  @HttpCode(201)
  async send(
    @Req() req: AuthedRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: SendMessageDto,
  ) {
    const contactId = await this.contactId(req);
    // Ownership check via listMessages' conversation guard.
    await this.comms.listMessages(conversationId, contactId);
    const result = await this.comms.send({
      contactId,
      conversationId,
      channel: 'in_app',
      category: 'transactional',
      body: body.body,
    });
    return { id: result.messageId, state: result.state };
  }
}
