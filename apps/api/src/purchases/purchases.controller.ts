import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import {
  CancelPurchaseDto,
  CreatePurchaseDto,
  ListPurchasesQueryDto,
} from './purchases.dto.js';
import { PurchasesService } from './purchases.service.js';

@ApiTags('Purchases')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE, UserRole.GODOWN)
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  @ApiOperation({
    summary: 'List purchases (filter by supplier, date range, status)',
  })
  list(@CurrentUser() actor: AuthUser, @Query() query: ListPurchasesQueryDto) {
    return this.purchases.list(actor, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchases.findOne(actor, id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Record a supplier bill: stock in, supplier ledger credit, all in one transaction',
  })
  @ApiConflictResponse({
    description: 'Bill number already entered for this supplier',
  })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreatePurchaseDto) {
    return this.purchases.create(actor, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel: reverse stock and post an opposite ledger entry',
  })
  @ApiConflictResponse({
    description: 'Already cancelled, or the stock was already sold/moved',
  })
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurchaseDto,
  ) {
    return this.purchases.cancel(actor, id, dto.reason);
  }
}
