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
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import {
  DecideCreditApprovalDto,
  ListCreditApprovalsQueryDto,
  RequestCreditApprovalDto,
} from './credit.dto.js';
import { CreditService } from './credit.service.js';

const { OWNER, MANAGER, OFFICE, SALESMAN } = UserRole;

@ApiTags('Credit')
@ApiBearerAuth()
@Controller()
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Roles(OWNER, MANAGER, OFFICE, SALESMAN)
  @Get('parties/:id/credit')
  @ApiOperation({
    summary: 'Party balance (from the ledger), credit limit and what is left',
  })
  summary(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credit.creditSummary(actor, id);
  }

  @Roles(OWNER, MANAGER, OFFICE)
  @Get('credit-approvals')
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListCreditApprovalsQueryDto,
  ) {
    return this.credit.list(actor, query);
  }

  @Roles(OFFICE, MANAGER)
  @Post('credit-approvals')
  @ApiOperation({
    summary:
      'Ask the owner to allow ONE invoice over the credit limit (valid until end of today)',
  })
  request(
    @CurrentUser() actor: AuthUser,
    @Body() dto: RequestCreditApprovalDto,
  ) {
    return this.credit.request(actor, dto);
  }

  @Roles(OWNER, MANAGER)
  @Post('credit-approvals/:id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Approve (owner; manager only below Rs 50,000 and not their own request)',
  })
  @ApiForbiddenResponse({
    description: 'Amount needs the owner, or manager deciding own request',
  })
  approve(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideCreditApprovalDto,
  ) {
    return this.credit.approve(actor, id, dto.note);
  }

  @Roles(OWNER, MANAGER)
  @Post('credit-approvals/:id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideCreditApprovalDto,
  ) {
    return this.credit.reject(actor, id, dto.note);
  }
}
