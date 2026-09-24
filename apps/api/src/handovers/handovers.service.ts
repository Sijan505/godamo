import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { handoverOutcome } from '../accounts/accounts-rules.js';
import { AuditService } from '../audit/audit.service.js';
import { getFiscalYear } from '../common/nepali-date/nepali-date.js';
import { nextDocNumber } from '../common/numbering/numbering.js';
import { pageArgs } from '../common/pagination.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  AuditAction,
  DocType,
  HandoverStatus,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ListHandoversQueryDto } from './handovers.dto.js';

const { Decimal } = Prisma;

const DETAIL_INCLUDE = {
  fromUser: { select: { id: true, name: true, role: true } },
  receivedBy: { select: { id: true, name: true } },
  payments: {
    select: {
      id: true,
      fiscalYear: true,
      receiptNo: true,
      amount: true,
      paymentDate: true,
      status: true,
      party: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.CashHandoverInclude;

/** Cash a person collected and still holds: active CASH receipts not yet handed over. */
export function cashInHandWhere(
  tenantId: string,
  userId?: string,
): Prisma.PaymentWhereInput {
  return {
    tenantId,
    ...(userId && { collectedById: userId }),
    direction: PaymentDirection.IN,
    method: PaymentMethod.CASH,
    status: PaymentStatus.ACTIVE,
    handoverId: null,
  };
}

@Injectable()
export class HandoversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scope(actor: AuthUser): Prisma.CashHandoverWhereInput {
    const field =
      actor.role === UserRole.SALESMAN || actor.role === UserRole.DRIVER;
    return {
      tenantId: actor.tenantId,
      ...(field && { fromUserId: actor.userId }),
    };
  }

  async myPending(actor: AuthUser) {
    const payments = await this.prisma.payment.findMany({
      where: cashInHandWhere(actor.tenantId, actor.userId),
      include: { party: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      total: payments.reduce((s, p) => s.plus(p.amount), new Decimal(0)),
      count: payments.length,
      payments,
    };
  }

  /** Hands over some of my pending cash; expectedAmount is their sum. */
  async submit(actor: AuthUser, paymentIds: string[]) {
    const ids = [...new Set(paymentIds)];
    const payments = await this.prisma.payment.findMany({
      where: {
        id: { in: ids },
        ...cashInHandWhere(actor.tenantId, actor.userId),
      },
    });
    if (payments.length !== ids.length) {
      throw new BadRequestException(
        'Every payment must be your own CASH receipt that is not reversed or already handed over',
      );
    }
    const expected = payments.reduce(
      (s, p) => s.plus(p.amount),
      new Decimal(0),
    );

    const id = await this.prisma.$transaction(async (tx) => {
      const fiscalYear = getFiscalYear(new Date());
      const n = await nextDocNumber(
        tx,
        actor.tenantId,
        DocType.HANDOVER,
        fiscalYear,
      );
      const handover = await tx.cashHandover.create({
        data: {
          tenantId: actor.tenantId,
          handoverNo: `HO-${fiscalYear}-${String(n).padStart(5, '0')}`,
          fromUserId: actor.userId,
          expectedAmount: expected,
        },
      });
      // Conditional: a payment can't end up in two handovers.
      const { count } = await tx.payment.updateMany({
        where: {
          id: { in: ids },
          ...cashInHandWhere(actor.tenantId, actor.userId),
        },
        data: { handoverId: handover.id },
      });
      if (count !== ids.length) {
        throw new ConflictException(
          'Some payments were handed over or reversed meanwhile',
        );
      }
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'CashHandover',
          entityId: handover.id,
          action: AuditAction.CREATE,
          newValue: {
            handoverNo: handover.handoverNo,
            expectedAmount: expected,
            paymentIds: ids,
          },
        },
        tx,
      );
      return handover.id;
    });
    return this.findOne(actor, id);
  }

  /** Office counts the cash: VERIFIED if it matches, DISPUTED (difference stored) if not. */
  async verify(
    actor: AuthUser,
    id: string,
    receivedAmount: number,
    note?: string,
  ) {
    const handover = await this.findOne(actor, id);
    if (handover.status !== HandoverStatus.SUBMITTED) {
      throw new ConflictException(
        `This handover is already ${handover.status}`,
      );
    }
    if (handover.fromUserId === actor.userId) {
      throw new BadRequestException('You cannot verify your own handover');
    }
    const received = new Decimal(receivedAmount);
    const outcome = handoverOutcome(handover.expectedAmount, received);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.cashHandover.updateMany({
        where: { id, status: HandoverStatus.SUBMITTED },
        data: {
          status: outcome.status,
          receivedAmount: received,
          difference: outcome.difference,
          receivedById: actor.userId,
          verifiedAt: new Date(),
          note,
        },
      });
      if (!count)
        throw new ConflictException('This handover was already verified');
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'CashHandover',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: {
            status: HandoverStatus.SUBMITTED,
            expectedAmount: handover.expectedAmount,
          },
          newValue: {
            status: outcome.status,
            receivedAmount: received,
            difference: outcome.difference,
            note,
          },
        },
        tx,
      );
    });
    return this.findOne(actor, id);
  }

  async list(actor: AuthUser, q: ListHandoversQueryDto) {
    const where: Prisma.CashHandoverWhereInput = {
      ...(q.fromUserId && { fromUserId: q.fromUserId }),
      ...this.scope(actor),
      status: q.status,
    };
    const [items, total] = await Promise.all([
      this.prisma.cashHandover.findMany({
        where,
        include: {
          fromUser: { select: { id: true, name: true } },
          receivedBy: { select: { id: true, name: true } },
          _count: { select: { payments: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.cashHandover.count({ where }),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async findOne(actor: AuthUser, id: string) {
    const handover = await this.prisma.cashHandover.findFirst({
      where: { id, ...this.scope(actor) },
      include: DETAIL_INCLUDE,
    });
    if (!handover) throw new NotFoundException('Handover not found');
    return handover;
  }
}
