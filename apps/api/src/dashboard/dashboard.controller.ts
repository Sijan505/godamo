import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import { DashboardService } from './dashboard.service.js';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      "Today's sales and collections, receivable/overdue, stock alerts, pending approvals and handovers, 7-day sales, top debtors, recent invoices",
  })
  summary(@CurrentUser() actor: AuthUser) {
    return this.dashboard.summary(actor);
  }
}
