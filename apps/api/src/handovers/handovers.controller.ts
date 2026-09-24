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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import {
  ListHandoversQueryDto,
  SubmitHandoverDto,
  VerifyHandoverDto,
} from './handovers.dto.js';
import { HandoversService } from './handovers.service.js';

const { OWNER, MANAGER, OFFICE, SALESMAN, DRIVER } = UserRole;

@ApiTags('Cash handovers')
@ApiBearerAuth()
@Controller('handovers')
export class HandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Roles(SALESMAN, DRIVER)
  @Get('my-pending')
  @ApiOperation({ summary: 'My CASH receipts not yet handed over, with total' })
  myPending(@CurrentUser() actor: AuthUser) {
    return this.handovers.myPending(actor);
  }

  @Roles(SALESMAN, DRIVER)
  @Post()
  @ApiOperation({ summary: 'Hand over cash (SUBMITTED; expectedAmount = sum)' })
  submit(@CurrentUser() actor: AuthUser, @Body() dto: SubmitHandoverDto) {
    return this.handovers.submit(actor, dto.paymentIds);
  }

  @Roles(OWNER, MANAGER, OFFICE)
  @Post(':id/verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Count the cash: VERIFIED if equal, DISPUTED with the difference',
  })
  verify(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyHandoverDto,
  ) {
    return this.handovers.verify(actor, id, dto.receivedAmount, dto.note);
  }

  @Roles(OWNER, MANAGER, OFFICE, SALESMAN, DRIVER)
  @Get()
  list(@CurrentUser() actor: AuthUser, @Query() query: ListHandoversQueryDto) {
    return this.handovers.list(actor, query);
  }

  @Roles(OWNER, MANAGER, OFFICE, SALESMAN, DRIVER)
  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.handovers.findOne(actor, id);
  }
}
