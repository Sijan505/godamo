import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  checkManualAllocations,
  fifoAllocate,
  type Allocation,
} from '../accounts/accounts-rules.js';
import { OutstandingService } from '../accounts/outstanding.service.js';
import { AuditService } from '../audit/audit.service.js';
import { dateOnly, nepalToday } from '../common/dates.js';
import { getFiscalYear } from '../common/nepali-date/nepali-date.js';
import { nextDocNumber } from '../common/numbering/numbering.js';
import { pageArgs } from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  AuditAction,
  ChequeStatus,
  DocType,
  HandoverStatus,
  LedgerEntryType,
  PartyType,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ListPaymentsQueryDto,
  PaySupplierDto,
  ReceivePaymentDto,
} from './payments.dto.js';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;
export const PAYMENT_REF = 'PAYMENT';

export const PAYMENT_DETAIL_INCLUDE = {
  party: {
    select: {
      id: true,
      name: true,
      phone: true,
      address: true,
      panVatNo: true,
    },
  },
  receivedBy: { select: { id: true, name: true } },
  collectedBy: { select: { id: true, name: true } },
  reversedBy: { select: { id: true, name: true } },
  handover: { select: { id: true, handoverNo: true, status: true } },
  allocations: {
    include: {
      invoice: {
        select: {
          id: true,
          fiscalYear: true,
          invoiceNo: true,
          invoiceDate: true,
          total: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.PaymentInclude;

type PaymentDetail = Prisma.PaymentGetPayload<{
  include: typeof PAYMENT_DETAIL_INCLUDE;
}>;

/** Field staff only see payments they collected themselves. */
const FIELD_ROLES: UserRole[] = [UserRole.SALESMAN, UserRole.DRIVER];

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly outstanding: OutstandingService,
  ) {}

  private scope(actor: AuthUser): Prisma.PaymentWhereInput {
    return {
      tenantId: actor.tenantId,
      ...(FIELD_ROLES.includes(actor.role) && { collectedById: actor.userId }),
    };
  }

  async list(actor: AuthUser, q: ListPaymentsQueryDto) {
    const where: Prisma.PaymentWhereInput = {
      ...(q.collectedById && { collectedById: q.collectedById }),
      ...this.scope(actor),
      partyId: q.partyId,
      direction: q.direction,
      method: q.method,
      chequeStatus: q.chequeStatus,
      status: q.status,
      ...((q.from || q.to) && {
        paymentDate: {
          ...(q.from && { gte: dateOnly(q.from) }),
          ...(q.to && { lte: dateOnly(q.to) }),
        },
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: {
          party: { select: { id: true, name: true } },
          collectedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  /** Payment with its allocations, what is still unallocated (advance) and the balance right after it. */
  async findOne(actor: AuthUser, id: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id, ...this.scope(actor) },
      include: PAYMENT_DETAIL_INCLUDE,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return this.withSummary(payment);
  }

  /**
   * Receives money from a customer. In ONE transaction: receipt number,
   * allocation to invoices (given, or FIFO oldest first; the rest is advance),
   * CREDIT ledger entry, audit. Safe to retry with the same clientUuid.
   */
  async receive(actor: AuthUser, dto: ReceivePaymentDto) {
    if (dto.clientUuid) {
      const existing = await this.findByClientUuid(actor, dto.clientUuid);
      if (existing) return existing;
    }
    const party = await this.prisma.party.findFirst({
      where: { id: dto.partyId, tenantId: actor.tenantId },
    });
    if (!party) throw new BadRequestException('Party not found');
    if (party.type === PartyType.SUPPLIER) {
      throw new BadRequestException(
        `${party.name} is not a customer; use /payments/pay`,
      );
    }
    assertChequeFields(dto);
    const amount = new Decimal(dto.amount);

    try {
      const id = await this.prisma.$transaction(
        async (tx) => {
          // One payment at a time per party, so two can't settle the same invoice twice.
          await tx.$queryRaw`SELECT id FROM parties WHERE id = ${party.id} FOR UPDATE`;
          const unpaid = await this.outstanding.unpaidInvoices(
            tx,
            actor.tenantId,
            party.id,
          );

          let allocations: Allocation[];
          if (dto.allocations?.length) {
            allocations = dto.allocations.map((a) => ({
              invoiceId: a.invoiceId,
              amount: new Decimal(a.amount),
            }));
            const errors = checkManualAllocations(
              amount,
              allocations,
              new Map(unpaid.map((u) => [u.invoiceId, u])),
            );
            if (errors.length) throw new BadRequestException(errors);
          } else {
            allocations = fifoAllocate(amount, unpaid).allocations;
          }

          const now = new Date();
          const fiscalYear = getFiscalYear(now);
          const receiptNo = await nextDocNumber(
            tx,
            actor.tenantId,
            DocType.RECEIPT,
            fiscalYear,
          );
          const payment = await tx.payment.create({
            data: {
              tenantId: actor.tenantId,
              partyId: party.id,
              direction: PaymentDirection.IN,
              fiscalYear,
              receiptNo,
              method: dto.method,
              amount,
              referenceNo: dto.referenceNo,
              chequeNo: dto.chequeNo,
              chequeBank: dto.chequeBank,
              chequeDate: dto.chequeDate ? dateOnly(dto.chequeDate) : null,
              chequeStatus:
                dto.method === PaymentMethod.CHEQUE
                  ? ChequeStatus.PENDING
                  : null,
              note: dto.note,
              paymentDate: nepalToday(now),
              receivedById: actor.userId,
              collectedById: actor.userId,
              clientUuid: dto.clientUuid,
              allocations: {
                createMany: {
                  data: allocations.map((a) => ({
                    tenantId: actor.tenantId,
                    invoiceId: a.invoiceId,
                    amount: a.amount,
                  })),
                },
              },
            },
          });

          // A pending cheque already reduces the balance; a bounce reverses it.
          await this.ledger.post(tx, {
            tenantId: actor.tenantId,
            partyId: party.id,
            entryDate: payment.paymentDate,
            type: LedgerEntryType.PAYMENT,
            credit: amount,
            refType: PAYMENT_REF,
            refId: payment.id,
            narration: `Receipt ${receiptNo} (${describeMethod(payment)})`,
          });
          await this.audit.log(
            {
              tenantId: actor.tenantId,
              userId: actor.userId,
              entity: 'Payment',
              entityId: payment.id,
              action: AuditAction.CREATE,
              newValue: {
                direction: 'IN',
                receiptNo,
                fiscalYear,
                partyId: party.id,
                amount,
                method: dto.method,
                allocations,
              },
            },
            tx,
          );
          return payment.id;
        },
        { timeout: 30_000 },
      );
      return this.findOne(actor, id);
    } catch (e) {
      if (dto.clientUuid && isUniqueViolation(e)) {
        const existing = await this.findByClientUuid(actor, dto.clientUuid);
        if (existing) return existing;
      }
      throw e;
    }
  }

  /** Pays a supplier: DEBIT to their ledger (we owe them less). */
  async paySupplier(actor: AuthUser, dto: PaySupplierDto) {
    const supplier = await this.prisma.party.findFirst({
      where: { id: dto.supplierId, tenantId: actor.tenantId },
    });
    if (!supplier) throw new BadRequestException('Supplier not found');
    if (supplier.type === PartyType.CUSTOMER) {
      throw new BadRequestException(`${supplier.name} is not a supplier`);
    }
    const amount = new Decimal(dto.amount);
    const id = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const fiscalYear = getFiscalYear(now);
      const receiptNo = await nextDocNumber(
        tx,
        actor.tenantId,
        DocType.SUPPLIER_PAYMENT,
        fiscalYear,
      );
      const payment = await tx.payment.create({
        data: {
          tenantId: actor.tenantId,
          partyId: supplier.id,
          direction: PaymentDirection.OUT,
          fiscalYear,
          receiptNo,
          method: dto.method,
          amount,
          referenceNo: dto.referenceNo,
          note: dto.note,
          paymentDate: nepalToday(now),
          receivedById: actor.userId,
          collectedById: actor.userId,
        },
      });
      await this.ledger.post(tx, {
        tenantId: actor.tenantId,
        partyId: supplier.id,
        entryDate: payment.paymentDate,
        type: LedgerEntryType.PURCHASE_PAYMENT,
        debit: amount,
        refType: PAYMENT_REF,
        refId: payment.id,
        narration: `Supplier payment ${receiptNo} (${describeMethod(payment)})`,
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Payment',
          entityId: payment.id,
          action: AuditAction.CREATE,
          newValue: {
            direction: 'OUT',
            receiptNo,
            fiscalYear,
            partyId: supplier.id,
            amount,
            method: dto.method,
          },
        },
        tx,
      );
      return payment.id;
    });
    return this.findOne(actor, id);
  }

  async chequeCleared(actor: AuthUser, id: string) {
    const payment = await this.getCheque(actor, id);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: {
          id,
          status: PaymentStatus.ACTIVE,
          chequeStatus: ChequeStatus.PENDING,
        },
        data: { chequeStatus: ChequeStatus.CLEARED },
      });
      if (!count)
        throw new ConflictException('The cheque is no longer pending');
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Payment',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: { chequeStatus: payment.chequeStatus },
          newValue: { chequeStatus: ChequeStatus.CLEARED },
        },
        tx,
      );
    });
    return this.findOne(actor, id);
  }

  /** Bounced cheque: reverse its ledger credit and allocations; the balance goes back up. */
  async chequeBounced(actor: AuthUser, id: string, reason: string) {
    const payment = await this.getCheque(actor, id);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: {
          id,
          status: PaymentStatus.ACTIVE,
          chequeStatus: ChequeStatus.PENDING,
        },
        data: {
          chequeStatus: ChequeStatus.BOUNCED,
          status: PaymentStatus.REVERSED,
          reversedAt: new Date(),
          reversedById: actor.userId,
          reversalReason: reason,
        },
      });
      if (!count)
        throw new ConflictException('The cheque is no longer pending');
      await this.undoEffects(
        tx,
        actor,
        payment,
        `Cheque ${payment.chequeNo} (${payment.chequeBank}) bounced: ${reason}`,
      );
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Payment',
          entityId: id,
          action: AuditAction.CANCEL,
          oldValue: {
            status: PaymentStatus.ACTIVE,
            chequeStatus: ChequeStatus.PENDING,
          },
          newValue: {
            status: PaymentStatus.REVERSED,
            chequeStatus: ChequeStatus.BOUNCED,
            reason,
          },
        },
        tx,
      );
    });
    return this.findOne(actor, id);
  }

  /** Reverses a payment (either direction). Nothing is deleted. */
  async reverse(actor: AuthUser, id: string, reason: string) {
    const payment = await this.findOne(actor, id);
    if (payment.status === PaymentStatus.REVERSED) {
      throw new ConflictException('This payment is already reversed');
    }
    if (payment.handover?.status === HandoverStatus.SUBMITTED) {
      throw new ConflictException(
        `This cash is in handover ${payment.handover.handoverNo}; verify or dispute it first`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id, status: PaymentStatus.ACTIVE },
        data: {
          status: PaymentStatus.REVERSED,
          reversedAt: new Date(),
          reversedById: actor.userId,
          reversalReason: reason,
        },
      });
      if (!count)
        throw new ConflictException('This payment is already reversed');
      await this.undoEffects(
        tx,
        actor,
        payment,
        `Receipt ${payment.receiptNo} reversed: ${reason}`,
      );
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Payment',
          entityId: id,
          action: AuditAction.CANCEL,
          oldValue: { status: PaymentStatus.ACTIVE },
          newValue: { status: PaymentStatus.REVERSED, reason },
        },
        tx,
      );
    });
    return this.findOne(actor, id);
  }

  /** Everything the receipt PDF needs. */
  async receiptData(actor: AuthUser, id: string) {
    const payment = await this.findOne(actor, id);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
    });
    return { payment, tenant };
  }

  /**
   * Opposite ledger row and negative allocation rows for everything still
   * allocated. Old rows are never edited or deleted.
   */
  private async undoEffects(
    tx: Tx,
    actor: AuthUser,
    payment: {
      id: string;
      partyId: string;
      amount: Decimal;
      direction: PaymentDirection;
    },
    narration: string,
  ) {
    const incoming = payment.direction === PaymentDirection.IN;
    await this.ledger.post(tx, {
      tenantId: actor.tenantId,
      partyId: payment.partyId,
      entryDate: nepalToday(),
      type: incoming
        ? LedgerEntryType.PAYMENT
        : LedgerEntryType.PURCHASE_PAYMENT,
      ...(incoming ? { debit: payment.amount } : { credit: payment.amount }),
      refType: PAYMENT_REF,
      refId: payment.id,
      narration,
    });
    const net = await tx.paymentAllocation.groupBy({
      by: ['invoiceId'],
      where: { paymentId: payment.id },
      _sum: { amount: true },
    });
    const undo = net.filter((n) => n._sum.amount?.gt(0));
    if (undo.length) {
      await tx.paymentAllocation.createMany({
        data: undo.map((n) => ({
          tenantId: actor.tenantId,
          paymentId: payment.id,
          invoiceId: n.invoiceId,
          amount: n._sum.amount!.neg(),
        })),
      });
    }
  }

  private async getCheque(actor: AuthUser, id: string) {
    const payment = await this.findOne(actor, id);
    if (payment.method !== PaymentMethod.CHEQUE) {
      throw new BadRequestException('This payment is not a cheque');
    }
    if (
      payment.status !== PaymentStatus.ACTIVE ||
      payment.chequeStatus !== ChequeStatus.PENDING
    ) {
      throw new ConflictException(
        `The cheque is ${payment.chequeStatus}${payment.status === PaymentStatus.REVERSED ? ' (payment reversed)' : ''}`,
      );
    }
    return payment;
  }

  private async findByClientUuid(actor: AuthUser, clientUuid: string) {
    const existing = await this.prisma.payment.findUnique({
      where: { clientUuid },
      include: PAYMENT_DETAIL_INCLUDE,
    });
    if (!existing) return null;
    const visible =
      existing.tenantId === actor.tenantId &&
      (!FIELD_ROLES.includes(actor.role) ||
        existing.collectedById === actor.userId);
    if (!visible) {
      throw new ConflictException(
        'This clientUuid is already used by another payment',
      );
    }
    return { ...(await this.withSummary(existing)), idempotentReplay: true };
  }

  private async withSummary(payment: PaymentDetail) {
    const allocated = payment.allocations.reduce(
      (s, a) => s.plus(a.amount),
      new Decimal(0),
    );
    // Balance right after this payment: all ledger rows up to its own.
    const own = await this.prisma.ledgerEntry.findFirst({
      where: {
        tenantId: payment.tenantId,
        refType: PAYMENT_REF,
        refId: payment.id,
      },
      orderBy: { createdAt: 'asc' },
    });
    const upTo = own
      ? await this.prisma.ledgerEntry.aggregate({
          where: {
            tenantId: payment.tenantId,
            partyId: payment.partyId,
            createdAt: { lte: own.createdAt },
          },
          _sum: { debit: true, credit: true },
        })
      : null;
    return {
      ...payment,
      allocatedAmount: allocated,
      unallocatedAmount:
        payment.status === PaymentStatus.ACTIVE
          ? payment.amount.minus(allocated)
          : new Decimal(0),
      balanceAfterPayment: upTo
        ? (upTo._sum.debit ?? new Decimal(0)).minus(
            upTo._sum.credit ?? new Decimal(0),
          )
        : null,
    };
  }
}

function assertChequeFields(dto: ReceivePaymentDto) {
  const cheque = dto.method === PaymentMethod.CHEQUE;
  const given = [dto.chequeNo, dto.chequeBank, dto.chequeDate];
  if (cheque && given.some((v) => !v)) {
    throw new BadRequestException(
      'chequeNo, chequeBank and chequeDate are required for CHEQUE',
    );
  }
  if (!cheque && given.some(Boolean)) {
    throw new BadRequestException(
      'Cheque details are only allowed when method is CHEQUE',
    );
  }
}

export function describeMethod(p: {
  method: PaymentMethod;
  chequeNo?: string | null;
  chequeBank?: string | null;
  referenceNo?: string | null;
}) {
  if (p.method === PaymentMethod.CHEQUE)
    return `Cheque ${p.chequeNo}, ${p.chequeBank}`;
  return p.referenceNo ? `${p.method} ref ${p.referenceNo}` : p.method;
}
