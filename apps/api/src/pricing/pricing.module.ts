import { Module } from '@nestjs/common';
import {
  PriceTiersController,
  PricingController,
  ProductPricesController,
} from './pricing.controller.js';
import { PricingService } from './pricing.service.js';

@Module({
  controllers: [
    PriceTiersController,
    ProductPricesController,
    PricingController,
  ],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
