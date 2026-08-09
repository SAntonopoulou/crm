import { Module, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../shared/jobs/job-scheduler';
import { ContactsModule } from '../contacts/contacts.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { ValuationService } from './valuation.service';

@Module({
  imports: [ContactsModule],
  providers: [PortfolioService, ValuationService],
  controllers: [PortfolioController],
  exports: [ValuationService],
})
export class PortfolioModule implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly portfolio: PortfolioService,
  ) {}

  onModuleInit(): void {
    this.registry.register('portfolio.revalue', async () => {
      await this.portfolio.refreshValuations();
    });
  }
}
