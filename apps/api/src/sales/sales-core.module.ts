import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module.js';
import { SaleLinesService } from './sale-lines.service.js';

/** Shared by sales orders and invoices. */
@Module({
  imports: [PricingModule],
  providers: [SaleLinesService],
  exports: [SaleLinesService],
})
export class SalesCoreModule {}
