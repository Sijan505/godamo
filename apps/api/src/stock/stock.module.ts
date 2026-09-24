import { Module } from '@nestjs/common';
import { GodownsModule } from '../godowns/godowns.module.js';
import { StockOperationsService } from './stock-operations.service.js';
import { StockReportsService } from './stock-reports.service.js';
import { StockController } from './stock.controller.js';
import { StockService } from './stock.service.js';

@Module({
  imports: [GodownsModule],
  controllers: [StockController],
  providers: [StockService, StockOperationsService, StockReportsService],
  exports: [StockService],
})
export class StockModule {}
