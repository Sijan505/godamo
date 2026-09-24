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
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { CategoriesService } from './categories.service.js';
import {
  CategoryNodeDto,
  CategoryTreeQueryDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto.js';

@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOkResponse({
    type: [CategoryNodeDto],
    description: 'Categories as a tree',
  })
  tree(@CurrentUser() actor: AuthUser, @Query() query: CategoryTreeQueryDto) {
    return this.categories.tree(actor, query.includeInactive);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.categories.findOne(actor, id);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.categories.create(actor, dto);
  }

  @Roles(...MASTER_DATA_WRITE_ROLES)
  @Patch(':id')
  @ApiOkResponse({ description: 'Use { "isActive": false } to deactivate' })
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(actor, id, dto);
  }
}
