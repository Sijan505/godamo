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
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import { CancelDto } from '../sales-orders/sales-orders.dto.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { CreateInvoiceDto, ListInvoicesQueryDto } from './invoices.dto.js';
import { InvoicesService } from './invoices.service.js';

@ApiTags('Invoices')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List invoices (party, date range, status, fiscal year)',
  })
  list(@CurrentUser() actor: AuthUser, @Query() query: ListInvoicesQueryDto) {
    return this.invoices.list(actor, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invoices.findOne(actor, id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Issue a VAT invoice. The server prices every line; stock (FEFO), ledger, numbering in one transaction.',
  })
  @ApiConflictResponse({
    description:
      'code CREDIT_LIMIT_EXCEEDED (with balance, creditLimit, invoiceTotal), CREDIT_APPROVAL_INVALID, or not enough stock',
  })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.invoices.create(actor, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cancel (never deleted, keeps its number): stock back, opposite ledger entry',
  })
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelDto,
  ) {
    return this.invoices.cancel(actor, id, dto.reason);
  }

  @Get(':id/pdf')
  @ApiOperation({
    summary:
      'A4 tax invoice PDF. First print is the original; later ones say "COPY OF ORIGINAL - Print #n".',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'PDF file' })
  async pdf(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.invoices.recordPrint(actor, id);
    const pdf = await renderInvoicePdf(data);
    const name = `invoice-${data.invoice.fiscalYear.replace('/', '-')}-${data.invoice.invoiceNo}.pdf`;
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${name}"`,
    });
  }
}
