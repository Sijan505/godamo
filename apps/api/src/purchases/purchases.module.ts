import { Module } from '@nestjs/common';
import { GodownsModule } from '../godowns/godowns.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { StockModule } from '../stock/stock.module.js';
import { PurchasesController } from './purchases.controller.js';
import { PurchasesService } from './purchases.service.js';

@Module({
  imports: [StockModule, LedgerModule, GodownsModule],
  controllers: [PurchasesController],
  providers: [PurchasesService],
})
export class PurchasesModule {}
