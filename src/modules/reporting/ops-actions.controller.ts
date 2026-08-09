import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AuthedRequest } from '../../shared/auth/auth.guard';
import { Roles } from '../../shared/auth/roles.guard';
import { AgentsService } from '../agents/agents.service';
import { ContactsService } from '../contacts/contacts.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { IngestService } from '../properties/ingest.service';
import { PrivacyService } from '../privacy/privacy.service';

export class QuarantineResolveDto {
  @IsIn(['accept', 'reject'])
  action!: 'accept' | 'reject';
}

export class DirectAssignDto {
  @IsUUID()
  agent_id!: string;
}

export class DisputeResolveDto {
  @IsObject()
  resolution!: Record<string, unknown>;

  @IsOptional()
  @IsIn(['active', 'revoked'])
  attribution_state?: 'active' | 'revoked';
}

export class RefuseDsrDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  grounds!: string;
}

export class SuspendAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Staff console write actions — every one routed through the audited domain services. */
@Controller('ops')
@Roles('staff')
export class OpsActionsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly ingest: IngestService,
    private readonly dispatch: DispatchService,
    private readonly privacy: PrivacyService,
    private readonly agents: AgentsService,
  ) {}

  private staffId(req: AuthedRequest): Promise<string> {
    return this.contacts.resolveOrProvision(req.auth!.sub);
  }

  @Post('quarantine/:quarantineId/resolve')
  async resolveQuarantine(
    @Req() req: AuthedRequest,
    @Param('quarantineId', ParseUUIDPipe) quarantineId: string,
    @Body() body: QuarantineResolveDto,
  ) {
    return this.ingest.resolveQuarantine(quarantineId, body.action, await this.staffId(req));
  }

  @Post('dispatch/:dispatchId/assign')
  async directAssign(
    @Req() req: AuthedRequest,
    @Param('dispatchId', ParseUUIDPipe) dispatchId: string,
    @Body() body: DirectAssignDto,
  ) {
    return this.dispatch.directAssign(dispatchId, body.agent_id, await this.staffId(req));
  }

  @Post('disputes/:disputeId/resolve')
  @HttpCode(204)
  async resolveDispute(
    @Req() req: AuthedRequest,
    @Param('disputeId', ParseUUIDPipe) disputeId: string,
    @Body() body: DisputeResolveDto,
  ) {
    await this.dispatch.resolveDispute(
      disputeId,
      await this.staffId(req),
      body.resolution,
      body.attribution_state,
    );
  }

  @Post('dsr/:dsrId/process-erasure')
  @HttpCode(204)
  async processErasure(
    @Req() req: AuthedRequest,
    @Param('dsrId', ParseUUIDPipe) dsrId: string,
  ) {
    await this.privacy.processErasure(dsrId, await this.staffId(req));
  }

  @Post('dsr/:dsrId/refuse')
  @HttpCode(204)
  async refuseDsr(
    @Req() req: AuthedRequest,
    @Param('dsrId', ParseUUIDPipe) dsrId: string,
    @Body() body: RefuseDsrDto,
  ) {
    await this.privacy.refuseDsr(dsrId, await this.staffId(req), body.grounds);
  }

  @Post('agents/:agentId/approve')
  @HttpCode(204)
  async approveAgent(
    @Req() req: AuthedRequest,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    await this.agents.approve(agentId, await this.staffId(req));
  }

  @Post('agents/:agentId/suspend')
  @HttpCode(204)
  async suspendAgent(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: SuspendAgentDto,
  ) {
    void body.reason;
    await this.agents.transition(agentId, 'suspended', { reason: 'manual' });
  }

  @Post('agents/:agentId/reinstate')
  @HttpCode(204)
  async reinstateAgent(@Param('agentId', ParseUUIDPipe) agentId: string) {
    await this.agents.transition(agentId, 'active');
  }
}
