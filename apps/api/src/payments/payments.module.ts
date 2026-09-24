import { Module } from '@nestjs/common';
import { AccountsCoreModule } from '../accounts/accounts-core.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [AccountsCoreModule, LedgerModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
