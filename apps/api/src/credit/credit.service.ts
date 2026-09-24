import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OutstandingService } from '../accounts/outstanding.service.js';
import { SettingsService } from '../accounts/settings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { addDays, nepalDayStart, nepalTodayString } from '../common/dates.js';
import { pageArgs } from '../common/pagination.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  AuditAction,
  CreditApprovalStatus,
  PartyType,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  approvalProblem,
  type CreditDecision,
  decisionProblem,
  evaluateCredit,
} from './credit-rules.js';
import type {
  ListCreditApprovalsQueryDto,
  RequestCreditApprovalDto,
} from './credit.dto.js';

type Db = PrismaService | Prisma.TransactionClient;
const { Decimal } = Prisma;

const APPROVAL_INCLUDE = {
  party: { select: { id: true, name: true, creditLimit: true } },
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
} satisfies Prisma.CreditApprovalInclude;

/**
 * Thrown by invoicing when credit is blocked; HTTP 409 with the numbers (and
 * the overdue bills) so the UI can offer "Request approval".
 */
export class CreditBlockedException extends ConflictException {
  constructor(partyName: string, d: CreditDecision) {
    const numbers = {
      balance: d.balance.toFixed(2),
      creditLimit: d.creditLimit.toFixed(2),
      invoiceTotal: d.amount.toFixed(2),
      balanceAfterInvoice: d.newBalance.toFixed(2),
    };
    if (d.code === 'OVERDUE_INVOICES') {
      super({
        statusCode: 409,
        code: 'OVERDUE_INVOICES',
        message:
          `${partyName} has ${d.overdueInvoices.length} overdue invoice(s). ` +
          'Collect payment or request a credit approval to continue.',
        ...numbers,
        creditLimitExceeded: d.limitExceeded,
        overdueInvoices: d.overdueInvoices.map((i) => ({
          invoiceId: i.invoiceId,
          invoiceNo: i.invoiceNo,
          fiscalYear: i.fiscalYear,
          invoiceDate: i.invoiceDate.toISOString().slice(0, 10),
          dueDate: i.dueDate.toISOString().slice(0, 10),
          daysOverdue: i.daysOverdue,
          outstanding: i.outstanding.toFixed(2),
        })),
      });
      return;
    }
    super({
      statusCode: 409,
      code: 'CREDIT_LIMIT_EXCEEDED',
      message:
        `Credit limit exceeded for ${partyName}: balance Rs ${d.balance.toFixed(2)} + ` +
        `invoice Rs ${d.amount.toFixed(2)} is more than the limit of Rs ${d.creditLimit.toFixed(2)}. ` +
        'Request a credit approval to continue.',
      ...numbers,
    });
  }
}

function approvalInvalid(message: string) {
  return new ConflictException({
    statusCode: 409,
    code: 'CREDIT_APPROVAL_INVALID',
    message,
  });
}

@Injectable()
export class CreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outstanding: OutstandingService,
    private readonly settings: SettingsService,
  ) {}

  /** Receivable balance: SUM(debit) - SUM(credit). Positive = party owes us. */
  getPartyBalance(db: Db, tenantId: string, partyId: string) {
    return this.outstanding.partyBalance(db, tenantId, partyId);
  }

  async checkCredit(
    db: Db,
    tenantId: string,
    party: { id: string; creditLimit: Prisma.Decimal },
    amount: Prisma.Decimal,
  ): Promise<CreditDecision> {
    const [balance, settings] = await Promise.all([
      this.getPartyBalance(db, tenantId, party.id),
      this.settings.get(db, tenantId),
    ]);
    const overdue = settings.blockOnOverdue
      ? await this.outstanding.overdueInvoices(
          db,
          tenantId,
          party.id,
          settings.overdueGraceDays,
        )
      : [];
    return evaluateCredit(
      balance,
      party.creditLimit,
      amount,
      overdue,
      settings.blockOnOverdue,
    );
  }

  async creditSummary(actor: AuthUser, partyId: string) {
    const party = await this.getParty(actor, partyId);
    const balance = await this.getPartyBalance(
      this.prisma,
      actor.tenantId,
      partyId,
    );
    return {
      partyId,
      partyName: party.name,
      balance: balance.toFixed(2),
      creditLimit: party.creditLimit.toFixed(2),
      available: Decimal.max(party.creditLimit.minus(balance), 0).toFixed(2),
      creditDays: party.creditDays,
    };
  }

  /**
   * Checks an approval can cover this invoice (APPROVED, same party, not
   * expired, amount big enough). Call it right after the credit check, before
   * any stock is touched, so the user gets the approval problem first.
   */
  async assertApprovalUsable(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    approvalId: string,
    invoice: { partyId: string; total: Prisma.Decimal },
  ) {
    const approval = await tx.creditApproval.findFirst({
      where: { id: approvalId, tenantId: actor.tenantId },
    });
    if (!approval) throw new BadRequestException('Credit approval not found');
    const problem = approvalProblem(approval, invoice);
    if (problem) throw approvalInvalid(problem);
  }

  /**
   * Marks the approval USED by this invoice, in the invoice's transaction.
   * The conditional update means one approval can never cover two invoices.
   */
  async markApprovalUsed(
    tx: Prisma.TransactionClient,
    approvalId: string,
    invoiceId: string,
  ) {
    const { count } = await tx.creditApproval.updateMany({
      where: { id: approvalId, status: CreditApprovalStatus.APPROVED },
      data: { status: CreditApprovalStatus.USED, usedByInvoiceId: invoiceId },
    });
    if (!count) {
      throw approvalInvalid(
        'The credit approval has already been used for another invoice',
      );
    }
  }

  // ─── Approval requests ─────────────────────────────────────────────────────

  async request(actor: AuthUser, dto: RequestCreditApprovalDto) {
    const party = await this.getParty(actor, dto.partyId);
    const balance = await this.getPartyBalance(
      this.prisma,
      actor.tenantId,
      party.id,
    );
    // Valid until the end of the Nepal day it was requested.
    const expiresAt = addDays(nepalDayStart(nepalTodayString()), 1);

    const approval = await this.prisma.$transaction(async (tx) => {
      const created = await tx.creditApproval.create({
        data: {
          tenantId: actor.tenantId,
          partyId: party.id,
          amount: dto.amount,
          reason: dto.reason,
          requestedById: actor.userId,
          expiresAt,
        },
        include: APPROVAL_INCLUDE,
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'CreditApproval',
          entityId: created.id,
          action: AuditAction.CREATE,
          newValue: {
            partyId: party.id,
            amount: dto.amount,
            reason: dto.reason,
            balance,
          },
        },
        tx,
      );
      return created;
    });
    return { ...approval, currentBalance: balance.toFixed(2) };
  }

  approve(actor: AuthUser, id: string, note?: string) {
    return this.decide(actor, id, CreditApprovalStatus.APPROVED, note);
  }

  reject(actor: AuthUser, id: string, note?: string) {
    return this.decide(actor, id, CreditApprovalStatus.REJECTED, note);
  }

  async list(actor: AuthUser, q: ListCreditApprovalsQueryDto) {
    const where: Prisma.CreditApprovalWhereInput = {
      tenantId: actor.tenantId,
      status: q.status,
      partyId: q.partyId,
    };
    const [rows, total] = await Promise.all([
      this.prisma.creditApproval.findMany({
        where,
        include: APPROVAL_INCLUDE,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.creditApproval.count({ where }),
    ]);
    const now = new Date();
    return {
      items: rows.map((r) => ({ ...r, expired: r.expiresAt <= now })),
      total,
      page: q.page,
      limit: q.limit,
    };
  }

  private async decide(
    actor: AuthUser,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    note?: string,
  ) {
    const request = await this.prisma.creditApproval.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!request) throw new NotFoundException('Credit approval not found');
    const problem = decisionProblem(actor, request);
    if (problem) throw new ForbiddenException(problem);
    if (request.status !== CreditApprovalStatus.PENDING) {
      throw new ConflictException(`This request is already ${request.status}`);
    }
    if (request.expiresAt <= new Date()) {
      throw new ConflictException(
        'This request has expired; ask for a new one',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.creditApproval.updateMany({
        where: { id, status: CreditApprovalStatus.PENDING },
        data: {
          status,
          approvedById: actor.userId,
          decidedAt: new Date(),
          decisionNote: note,
        },
      });
      if (!count)
        throw new ConflictException('This request was already decided');
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'CreditApproval',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: { status: CreditApprovalStatus.PENDING },
          newValue: { status, note },
        },
        tx,
      );
      return tx.creditApproval.findUniqueOrThrow({
        where: { id },
        include: APPROVAL_INCLUDE,
      });
    });
  }

  private async getParty(actor: AuthUser, partyId: string) {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId: actor.tenantId },
    });
    if (!party) throw new NotFoundException('Party not found');
    if (party.type === PartyType.SUPPLIER) {
      throw new BadRequestException(`${party.name} is not a customer`);
    }
    return party;
  }
}
