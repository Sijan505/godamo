import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module.js';
import { ProductImportService } from './product-import.service.js';
import {
  ProductImportController,
  ProductsController,
} from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [PricingModule],
  controllers: [ProductImportController, ProductsController],
  providers: [ProductsService, ProductImportService],
})
export class ProductsModule {}
