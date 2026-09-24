import {
  Body,
  Controller,
  Get,
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
import { renderLedgerPdf } from './ledger-pdf.js';
import { LedgerQueryDto, OpeningBalanceDto } from './party-accounts.dto.js';
import { PartyAccountsService } from './party-accounts.service.js';

const { OWNER, MANAGER, OFFICE, SALESMAN } = UserRole;

@ApiTags('Parties')
@ApiBearerAuth()
@Controller('parties')
export class PartyAccountsController {
  constructor(private readonly accounts: PartyAccountsService) {}

  @Roles(OWNER)
  @Post(':id/opening-balance')
  @ApiOperation({
    summary: 'Set the opening balance (owner only, once per party)',
  })
  @ApiConflictResponse({
    description: 'The party already has an opening balance',
  })
  opening(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpeningBalanceDto,
  ) {
    return this.accounts.setOpeningBalance(actor, id, dto);
  }

  @Roles(OWNER, MANAGER, OFFICE, SALESMAN)
  @Get(':id/ledger')
  @ApiOperation({
    summary:
      'Ledger statement: opening, entries with BS dates and running balance, closing',
  })
  ledger(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.accounts.statement(actor, id, query);
  }

  @Roles(OWNER, MANAGER, OFFICE, SALESMAN)
  @Get(':id/ledger/pdf')
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'PDF file' })
  async ledgerPdf(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LedgerQueryDto,
  ) {
    const [statement, tenant] = await Promise.all([
      this.accounts.statement(actor, id, query),
      this.accounts.tenant(actor),
    ]);
    return new StreamableFile(await renderLedgerPdf(statement, tenant), {
      type: 'application/pdf',
      disposition: `inline; filename="ledger-${statement.party.name.replace(/[^A-Za-z0-9]+/g, '-')}.pdf"`,
    });
  }

  @Roles(OWNER, MANAGER, OFFICE, SALESMAN)
  @Get(':id/reminder')
  @ApiOperation({
    summary: 'Payment reminder text (Nepali + English) and a WhatsApp link',
  })
  reminder(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.reminder(actor, id);
  }
}
