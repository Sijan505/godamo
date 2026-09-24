import { Module } from '@nestjs/common';
import { AccountsCoreModule } from '../accounts/accounts-core.module.js';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';

@Module({
  imports: [AccountsCoreModule],
  controllers: [PartiesController],
  providers: [PartiesService],
})
export class PartiesModule {}
