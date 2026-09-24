import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import {
  CancelDto,
  CreateSalesOrderDto,
  ListSalesOrdersQueryDto,
  UpdateSalesOrderDto,
} from './sales-orders.dto.js';
import { SalesOrdersService } from './sales-orders.service.js';

@ApiTags('Sales orders')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE, UserRole.SALESMAN)
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService) {}

  @Get()
  @ApiOperation({ summary: 'List orders (salesmen see only their own)' })
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListSalesOrdersQueryDto,
  ) {
    return this.orders.list(actor, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.findOne(actor, id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Book an order. Prices come from the server; the same clientUuid returns the existing order.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'An item has no price for this party',
  })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateSalesOrderDto) {
    return this.orders.create(actor, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a DRAFT order (items are re-priced)' })
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalesOrderDto,
  ) {
    return this.orders.update(actor, id, dto);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.confirm(actor, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelDto,
  ) {
    return this.orders.cancel(actor, id, dto.reason);
  }
}
