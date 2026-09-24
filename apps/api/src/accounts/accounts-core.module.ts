import { Module } from '@nestjs/common';
import { OutstandingService } from './outstanding.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

/** Balances, invoice outstanding and tenant settings, shared by many modules. */
@Module({
  controllers: [SettingsController],
  providers: [OutstandingService, SettingsService],
  exports: [OutstandingService, SettingsService],
})
export class AccountsCoreModule {}
