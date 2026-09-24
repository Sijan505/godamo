import { Module } from '@nestjs/common';
import { HandoversController } from './handovers.controller.js';
import { HandoversService } from './handovers.service.js';

@Module({
  controllers: [HandoversController],
  providers: [HandoversService],
})
export class HandoversModule {}
