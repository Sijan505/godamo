import { Module } from '@nestjs/common';
import { AccountsCoreModule } from '../accounts/accounts-core.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [AccountsCoreModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
