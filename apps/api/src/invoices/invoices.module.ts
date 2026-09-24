import { Module } from '@nestjs/common';
import { AccountsCoreModule } from '../accounts/accounts-core.module.js';
import { CreditModule } from '../credit/credit.module.js';
import { GodownsModule } from '../godowns/godowns.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { SalesCoreModule } from '../sales/sales-core.module.js';
import { StockModule } from '../stock/stock.module.js';
import { InvoicesController } from './invoices.controller.js';
import { InvoicesService } from './invoices.service.js';

@Module({
  imports: [
    AccountsCoreModule,

    SalesCoreModule,
    StockModule,
    LedgerModule,
    CreditModule,
    GodownsModule,
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService],
})
export class InvoicesModule {}
