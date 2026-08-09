import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { Roles } from '../../shared/auth/roles.guard';
import { ContactsService } from '../contacts/contacts.service';
import { DispatchService } from './dispatch.service';

@Controller('agent/offers')
@Roles('agent')
export class OffersController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly contacts: ContactsService,
  ) {}

  private agentId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.dispatch.listOffers(await this.agentId(req));
  }

  @Post(':offerId/claim')
  async claim(
    @Req() req: AuthedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Headers('x-offline-replay') offlineReplay?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    // Contract: claims are ONLINE-ONLY, never accepted from an offline queue.
    if (offlineReplay) {
      throw new UnprocessableEntityException({ code: 'claims_online_only' });
    }
    return this.dispatch.claim(offerId, await this.agentId(req), {
      ip: forwardedFor?.split(',')[0]?.trim(),
    });
  }

  @Post(':offerId/decline')
  @HttpCode(204)
  async decline(
    @Req() req: AuthedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    await this.dispatch.decline(offerId, await this.agentId(req));
  }
}
