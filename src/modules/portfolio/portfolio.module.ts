import { Module } from '@nestjs/common';
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
export class PortfolioModule {}
