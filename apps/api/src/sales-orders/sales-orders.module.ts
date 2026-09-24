import { Module } from '@nestjs/common';
import { GodownsModule } from '../godowns/godowns.module.js';
import { SalesCoreModule } from '../sales/sales-core.module.js';
import { StockModule } from '../stock/stock.module.js';
import { SalesOrdersController } from './sales-orders.controller.js';
import { SalesOrdersService } from './sales-orders.service.js';

@Module({
  imports: [SalesCoreModule, StockModule, GodownsModule],
  controllers: [SalesOrdersController],
  providers: [SalesOrdersService],
})
export class SalesOrdersModule {}
