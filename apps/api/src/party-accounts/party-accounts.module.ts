import { Module } from '@nestjs/common';
import { AccountsCoreModule } from '../accounts/accounts-core.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { PartyAccountsController } from './party-accounts.controller.js';
import { PartyAccountsService } from './party-accounts.service.js';

@Module({
  imports: [AccountsCoreModule, LedgerModule],
  controllers: [PartyAccountsController],
  providers: [PartyAccountsService],
})
export class PartyAccountsModule {}
