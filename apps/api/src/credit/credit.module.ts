import { Module } from '@nestjs/common';
import { AccountsCoreModule } from '../accounts/accounts-core.module.js';
import { CreditController } from './credit.controller.js';
import { CreditService } from './credit.service.js';

@Module({
  imports: [AccountsCoreModule],
  controllers: [CreditController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
