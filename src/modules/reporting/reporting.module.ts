import { Module } from '@nestjs/common';
import { OpsController } from './reporting.controller';
import { ReportingService } from './reporting.service';

@Module({
  providers: [ReportingService],
  controllers: [OpsController],
})
export class ReportingModule {}
