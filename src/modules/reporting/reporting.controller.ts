import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../shared/auth/roles.guard';
import { ReportingService } from './reporting.service';

@Controller('ops')
@Roles('staff')
export class OpsController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('funnel')
  funnel() {
    return this.reporting.funnel();
  }

  @Get('dispatch')
  dispatch() {
    return this.reporting.dispatchMetrics();
  }

  @Get('sla')
  sla() {
    return this.reporting.slaMetrics();
  }

  @Get('queues')
  queues() {
    return this.reporting.workQueues();
  }

  @Get('health')
  health() {
    return this.reporting.systemHealth();
  }
}
