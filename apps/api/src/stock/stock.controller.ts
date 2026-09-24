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
import { StockOperationsService } from './stock-operations.service.js';
import { StockReportsService } from './stock-reports.service.js';
import {
  CreateAdjustmentDto,
  CreateCountDto,
  CreateTransferDto,
  ExpiringQueryDto,
  GodownFilterQueryDto,
  ListCountsQueryDto,
  StockCardQueryDto,
  StockListQueryDto,
} from './stock.dto.js';

const { OWNER, MANAGER, GODOWN } = UserRole;
const NOT_ENOUGH = 'Not enough stock (message includes what is available)';

@ApiTags('Stock')
@ApiBearerAuth()
@Controller('stock')
export class StockController {
  constructor(
    private readonly ops: StockOperationsService,
    private readonly reports: StockReportsService,
  ) {}

  // ─── Reports (everyone) ────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Stock per product: base qty, "5 carton 2 box", value',
  })
  list(@CurrentUser() actor: AuthUser, @Query() query: StockListQueryDto) {
    return this.reports.list(actor, query);
  }

  @Get('low')
  @ApiOperation({ summary: 'Products at or below their reorder level' })
  low(@CurrentUser() actor: AuthUser, @Query() query: GodownFilterQueryDto) {
    return this.reports.low(actor, query.godownId);
  }

  @Get('expiring')
  @ApiOperation({
    summary: 'Batches expiring within N days (expired ones flagged)',
  })
  expiring(@CurrentUser() actor: AuthUser, @Query() query: ExpiringQueryDto) {
    return this.reports.expiring(actor, query);
  }

  @Get('valuation')
  @ApiOperation({
    summary: 'Stock value per godown (weighted average purchase cost)',
  })
  valuation(@CurrentUser() actor: AuthUser) {
    return this.reports.valuation(actor);
  }

  @Get(':productId/card')
  @ApiOperation({
    summary: 'Stock card: every movement with a running balance',
  })
  card(
    @CurrentUser() actor: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: StockCardQueryDto,
  ) {
    return this.reports.card(actor, productId, query);
  }

  // ─── Operations ────────────────────────────────────────────────────────────

  @Roles(OWNER, MANAGER, GODOWN)
  @Post('transfers')
  @ApiOperation({ summary: 'Move stock between godowns (one transaction)' })
  @ApiConflictResponse({ description: NOT_ENOUGH })
  transfer(@CurrentUser() actor: AuthUser, @Body() dto: CreateTransferDto) {
    return this.ops.transfer(actor, dto);
  }

  @Roles(OWNER, MANAGER)
  @Post('adjustments')
  @ApiOperation({
    summary: 'Manual ADJUSTMENT (+/-) or DAMAGE (-) with a reason',
  })
  @ApiConflictResponse({ description: NOT_ENOUGH })
  adjust(@CurrentUser() actor: AuthUser, @Body() dto: CreateAdjustmentDto) {
    return this.ops.adjust(actor, dto);
  }

  @Roles(OWNER, MANAGER, GODOWN)
  @Get('counts')
  listCounts(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListCountsQueryDto,
  ) {
    return this.ops.listCounts(actor, query);
  }

  @Roles(OWNER, MANAGER, GODOWN)
  @Get('counts/:id')
  findCount(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.findCount(actor, id);
  }

  @Roles(OWNER, MANAGER, GODOWN)
  @Post('counts')
  @ApiOperation({
    summary: 'Record a physical count; returns differences vs system stock',
  })
  createCount(@CurrentUser() actor: AuthUser, @Body() dto: CreateCountDto) {
    return this.ops.createCount(actor, dto);
  }

  @Roles(OWNER, MANAGER)
  @Post('counts/:id/apply')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Post ADJUSTMENT movements for the count differences',
  })
  @ApiConflictResponse({
    description: `Already applied, or ${NOT_ENOUGH.toLowerCase()}`,
  })
  applyCount(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.applyCount(actor, id);
  }
}
