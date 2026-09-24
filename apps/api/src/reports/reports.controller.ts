import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import { AgeingQueryDto, DateRangeQueryDto } from './reports.dto.js';
import { ReportsService } from './reports.service.js';

@ApiTags('Reports')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('ageing')
  @ApiOperation({
    summary: 'Receivable ageing per customer (0-30, 31-60, 61-90, 90+ days)',
  })
  ageing(@CurrentUser() actor: AuthUser, @Query() query: AgeingQueryDto) {
    return this.reports.ageing(actor, query);
  }

  @Get('outstanding')
  @ApiOperation({ summary: 'Total receivable, total payable, top 10 debtors' })
  outstanding(@CurrentUser() actor: AuthUser) {
    return this.reports.outstanding(actor);
  }

  @Get('collections')
  @ApiOperation({ summary: 'Receipts by method, by collector and by day' })
  collections(
    @CurrentUser() actor: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reports.collections(actor, query);
  }

  @Get('cash-in-hand')
  @ApiOperation({
    summary: 'Cash each person holds (not handed over / not yet verified)',
  })
  cashInHand(@CurrentUser() actor: AuthUser) {
    return this.reports.cashInHand(actor);
  }
}
