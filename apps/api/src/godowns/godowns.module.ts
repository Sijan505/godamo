import { Module } from '@nestjs/common';
import { GodownsController } from './godowns.controller.js';
import { GodownsService } from './godowns.service.js';

@Module({
  controllers: [GodownsController],
  providers: [GodownsService],
  exports: [GodownsService],
})
export class GodownsModule {}
