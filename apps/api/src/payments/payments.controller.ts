import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import {
  ListPaymentsQueryDto,
  PaySupplierDto,
  ReasonDto,
  ReceivePaymentDto,
} from './payments.dto.js';
import { PaymentsService } from './payments.service.js';
import { renderReceiptPdf } from './receipt-pdf.js';

const { OWNER, MANAGER, OFFICE, SALESMAN, DRIVER } = UserRole;

@ApiTags('Payments')
@ApiBearerAuth()
@Roles(OWNER, MANAGER, OFFICE, SALESMAN, DRIVER)
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({
    summary: 'List payments (salesmen/drivers see only what they collected)',
  })
  list(@CurrentUser() actor: AuthUser, @Query() query: ListPaymentsQueryDto) {
    return this.payments.list(actor, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payments.findOne(actor, id);
  }

  @Post('receive')
  @ApiOperation({
    summary:
      'Receive from a customer: receipt no., allocation (given or FIFO; rest = advance), ledger CREDIT. Idempotent by clientUuid.',
  })
  receive(@CurrentUser() actor: AuthUser, @Body() dto: ReceivePaymentDto) {
    return this.payments.receive(actor, dto);
  }

  @Roles(OWNER, MANAGER, OFFICE)
  @Post('pay')
  @ApiOperation({ summary: 'Pay a supplier: ledger DEBIT (PURCHASE_PAYMENT)' })
  pay(@CurrentUser() actor: AuthUser, @Body() dto: PaySupplierDto) {
    return this.payments.paySupplier(actor, dto);
  }

  @Roles(OWNER, MANAGER, OFFICE)
  @Post(':id/cheque-cleared')
  @HttpCode(200)
  chequeCleared(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payments.chequeCleared(actor, id);
  }

  @Roles(OWNER, MANAGER, OFFICE)
  @Post(':id/cheque-bounced')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bounced: ledger and allocations reversed, balance goes back up',
  })
  chequeBounced(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.payments.chequeBounced(actor, id, dto.reason);
  }

  @Roles(OWNER, MANAGER)
  @Post(':id/reverse')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Reverse: status REVERSED, reversal ledger row, negative allocations',
  })
  reverse(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.payments.reverse(actor, id, dto.reason);
  }

  @Get(':id/receipt-pdf')
  @ApiOperation({ summary: '80 mm thermal receipt' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'PDF file' })
  async receipt(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.payments.receiptData(actor, id);
    const pdf = await renderReceiptPdf(data);
    const name = `receipt-${data.payment.fiscalYear.replace('/', '-')}-${data.payment.receiptNo}.pdf`;
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${name}"`,
    });
  }
}
