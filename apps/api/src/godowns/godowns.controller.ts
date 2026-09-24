import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import {
  CreateGodownDto,
  ListGodownsQueryDto,
  UpdateGodownDto,
} from './godowns.dto.js';
import { GodownsService } from './godowns.service.js';

@ApiTags('Godowns')
@ApiBearerAuth()
@Controller('godowns')
export class GodownsController {
  constructor(private readonly godowns: GodownsService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser, @Query() query: ListGodownsQueryDto) {
    return this.godowns.list(actor, query.includeInactive);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.godowns.findOne(actor, id);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateGodownDto) {
    return this.godowns.create(actor, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGodownDto,
  ) {
    return this.godowns.update(actor, id, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Patch(':id/deactivate')
  @ApiConflictResponse({ description: 'The godown still has stock' })
  deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.godowns.deactivate(actor, id);
  }
}
