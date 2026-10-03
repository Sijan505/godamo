import { checkManualAllocations, fifoAllocate } from '../accounts/accounts-rules.js';
import { unpaidInvoices } from '../accounts/outstanding.js';
import { auditLog } from '../common/audit.js';
import { dateOnly as toDateOnly, nepalToday } from '../common/dates.js';
import { postLedger } from '../common/ledger.js';
import { getFiscalYear } from '../common/nepali-date.js';
import { nextDocNumber } from '../common/numbering.js';
import { pageArgs, paginationDefaults, paginationFields } from '../common/pagination.js';
import {
  AuditAction,
  ChequeStatus,
  Decimal,
  DocType,
  HandoverStatus,
  LedgerEntryType,
  PartyType,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
  UserRole,
  isUniqueViolation,
  prisma,
} from '../db.js';
import { BadRequest, Conflict, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  arrayMaxSize,
  dateOnly,
  isArray,
  isEnum,
  isNumber,
  isPositive,
  isString,
  isUuid,
  length,
  max,
  nested,
  optional,
  schema,
  trim,
} from '../http/validation.js';
import { sendPdf } from '../invoices/invoices.js';
import { MAX_MONEY } from '../pricing/pricing.js';
import { renderReceiptPdf } from './receipt-pdf.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const money = () => [isNumber({ maxDecimalPlaces: 2 }), isPositive(), max(MAX_MONEY)];

const AllocationDto = schema({
  invoiceId: [isUuid()],
  amount: money(),
});

const ReceivePaymentDto = schema({
  partyId: [isUuid()],
  amount: money(),
  method: [isEnum(PaymentMethod)],
  /** Bank / Fonepay / eSewa / Khalti transaction id */
  referenceNo: [optional(), trim(), isString(), length(1, 100)],
  /** Required for CHEQUE */
  chequeNo: [optional(), trim(), isString(), length(1, 30)],
  /** Required for CHEQUE */
  chequeBank: [optional(), trim(), isString(), length(1, 100)],
  /** Required for CHEQUE */
  chequeDate: [optional(), dateOnly()],
  /** Omit to settle the oldest unpaid invoices first (FIFO) */
  allocations: [optional(), isArray(), arrayMaxSize(200), nested(AllocationDto)],
  note: [optional(), trim(), isString(), length(1, 500)],
  /** Unique id from the (offline) client; a repeat returns the existing payment */
  clientUuid: [optional(), isUuid()],
});

const PaySupplierDto = schema({
  supplierId: [isUuid()],
  amount: money(),
  method: [isEnum(PaymentMethod)],
  /** Cheque no. / bank transaction id */
  referenceNo: [optional(), trim(), isString(), length(1, 100)],
  note: [optional(), trim(), isString(), length(1, 500)],
});

export const ReasonDto = schema({
  reason: [trim(), isString(), length(3, 500)],
});

const ListPaymentsQueryDto = schema(
  {
    partyId: [optional(), isUuid()],
    direction: [optional(), isEnum(PaymentDirection)],
    method: [optional(), isEnum(PaymentMethod)],
    /** Ignored for salesmen/drivers (always themselves) */
    collectedById: [optional(), isUuid()],
    chequeStatus: [optional(), isEnum(ChequeStatus)],
    status: [optional(), isEnum(PaymentStatus)],
    from: [optional(), dateOnly()],
    to: [optional(), dateOnly()],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

// ─── Service ────────────────────────────────────────────────────────────────

export const PAYMENT_REF = 'PAYMENT';

export const PAYMENT_DETAIL_INCLUDE = {
  party: { select: { id: true, name: true, phone: true, address: true, panVatNo: true } },
  receivedBy: { select: { id: true, name: true } },
  collectedBy: { select: { id: true, name: true } },
  reversedBy: { select: { id: true, name: true } },
  handover: { select: { id: true, handoverNo: true, status: true } },
  allocations: {
    include: {
      invoice: {
        select: { id: true, fiscalYear: true, invoiceNo: true, invoiceDate: true, total: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
};

/** Field staff only see payments they collected themselves. */
const FIELD_ROLES = [UserRole.SALESMAN, UserRole.DRIVER];

function scope(actor) {
  return {
    tenantId: actor.tenantId,
    ...(FIELD_ROLES.includes(actor.role) && { collectedById: actor.userId }),
  };
}

export async function list(actor, q) {
  const where = {
    ...(q.collectedById && { collectedById: q.collectedById }),
    ...scope(actor),
    partyId: q.partyId,
    direction: q.direction,
    method: q.method,
    chequeStatus: q.chequeStatus,
    status: q.status,
    ...((q.from || q.to) && {
      paymentDate: {
        ...(q.from && { gte: toDateOnly(q.from) }),
        ...(q.to && { lte: toDateOnly(q.to) }),
      },
    }),
  };
  const [items, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        party: { select: { id: true, name: true } },
        collectedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
      ...pageArgs(q),
    }),
    prisma.payment.count({ where }),
  ]);
  return { items, total, page: q.page, limit: q.limit };
}

/** Payment with its allocations, what is still unallocated (advance) and the balance right after it. */
export async function findOne(actor, id) {
  const payment = await prisma.payment.findFirst({
    where: { id, ...scope(actor) },
    include: PAYMENT_DETAIL_INCLUDE,
  });
  if (!payment) throw NotFound('Payment not found');
  return withSummary(payment);
}

/**
 * Receives money from a customer. In ONE transaction: receipt number,
 * allocation to invoices (given, or FIFO oldest first; the rest is advance),
 * CREDIT ledger entry, audit. Safe to retry with the same clientUuid.
 */
export async function receive(actor, dto) {
  if (dto.clientUuid) {
    const existing = await findByClientUuid(actor, dto.clientUuid);
    if (existing) return existing;
  }
  const party = await prisma.party.findFirst({ where: { id: dto.partyId, tenantId: actor.tenantId } });
  if (!party) throw BadRequest('Party not found');
  if (party.type === PartyType.SUPPLIER) {
    throw BadRequest(`${party.name} is not a customer; use /payments/pay`);
  }
  assertChequeFields(dto);
  const amount = new Decimal(dto.amount);

  try {
    const id = await prisma.$transaction(
      async (tx) => {
        // One payment at a time per party, so two can't settle the same invoice twice.
        await tx.$queryRaw`SELECT id FROM parties WHERE id = ${party.id} FOR UPDATE`;
        const unpaid = await unpaidInvoices(tx, actor.tenantId, party.id);

        let allocations;
        if (dto.allocations?.length) {
          allocations = dto.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: new Decimal(a.amount) }));
          const errors = checkManualAllocations(
            amount,
            allocations,
            new Map(unpaid.map((u) => [u.invoiceId, u])),
          );
          if (errors.length) throw BadRequest(errors);
        } else {
          allocations = fifoAllocate(amount, unpaid).allocations;
        }

        const now = new Date();
        const fiscalYear = getFiscalYear(now);
        const receiptNo = await nextDocNumber(tx, actor.tenantId, DocType.RECEIPT, fiscalYear);
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
            chequeDate: dto.chequeDate ? toDateOnly(dto.chequeDate) : null,
            chequeStatus: dto.method === PaymentMethod.CHEQUE ? ChequeStatus.PENDING : null,
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
        await postLedger(tx, {
          tenantId: actor.tenantId,
          partyId: party.id,
          entryDate: payment.paymentDate,
          type: LedgerEntryType.PAYMENT,
          credit: amount,
          refType: PAYMENT_REF,
          refId: payment.id,
          narration: `Receipt ${receiptNo} (${describeMethod(payment)})`,
        });
        await auditLog(
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
    return findOne(actor, id);
  } catch (e) {
    if (dto.clientUuid && isUniqueViolation(e)) {
      const existing = await findByClientUuid(actor, dto.clientUuid);
      if (existing) return existing;
    }
    throw e;
  }
}

/** Pays a supplier: DEBIT to their ledger (we owe them less). */
export async function paySupplier(actor, dto) {
  const supplier = await prisma.party.findFirst({ where: { id: dto.supplierId, tenantId: actor.tenantId } });
  if (!supplier) throw BadRequest('Supplier not found');
  if (supplier.type === PartyType.CUSTOMER) throw BadRequest(`${supplier.name} is not a supplier`);
  const amount = new Decimal(dto.amount);
  const id = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const fiscalYear = getFiscalYear(now);
    const receiptNo = await nextDocNumber(tx, actor.tenantId, DocType.SUPPLIER_PAYMENT, fiscalYear);
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
    await postLedger(tx, {
      tenantId: actor.tenantId,
      partyId: supplier.id,
      entryDate: payment.paymentDate,
      type: LedgerEntryType.PURCHASE_PAYMENT,
      debit: amount,
      refType: PAYMENT_REF,
      refId: payment.id,
      narration: `Supplier payment ${receiptNo} (${describeMethod(payment)})`,
    });
    await auditLog(
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
  return findOne(actor, id);
}

export async function chequeCleared(actor, id) {
  const payment = await getCheque(actor, id);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id, status: PaymentStatus.ACTIVE, chequeStatus: ChequeStatus.PENDING },
      data: { chequeStatus: ChequeStatus.CLEARED },
    });
    if (!count) throw Conflict('The cheque is no longer pending');
    await auditLog(
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
  return findOne(actor, id);
}

/** Bounced cheque: reverse its ledger credit and allocations; the balance goes back up. */
export async function chequeBounced(actor, id, reason) {
  const payment = await getCheque(actor, id);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id, status: PaymentStatus.ACTIVE, chequeStatus: ChequeStatus.PENDING },
      data: {
        chequeStatus: ChequeStatus.BOUNCED,
        status: PaymentStatus.REVERSED,
        reversedAt: new Date(),
        reversedById: actor.userId,
        reversalReason: reason,
      },
    });
    if (!count) throw Conflict('The cheque is no longer pending');
    await undoEffects(
      tx,
      actor,
      payment,
      `Cheque ${payment.chequeNo} (${payment.chequeBank}) bounced: ${reason}`,
    );
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'Payment',
        entityId: id,
        action: AuditAction.CANCEL,
        oldValue: { status: PaymentStatus.ACTIVE, chequeStatus: ChequeStatus.PENDING },
        newValue: { status: PaymentStatus.REVERSED, chequeStatus: ChequeStatus.BOUNCED, reason },
      },
      tx,
    );
  });
  return findOne(actor, id);
}

/** Reverses a payment (either direction). Nothing is deleted. */
export async function reverse(actor, id, reason) {
  const payment = await findOne(actor, id);
  if (payment.status === PaymentStatus.REVERSED) throw Conflict('This payment is already reversed');
  if (payment.handover?.status === HandoverStatus.SUBMITTED) {
    throw Conflict(
      `This cash is in handover ${payment.handover.handoverNo}; verify or dispute it first`,
    );
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id, status: PaymentStatus.ACTIVE },
      data: {
        status: PaymentStatus.REVERSED,
        reversedAt: new Date(),
        reversedById: actor.userId,
        reversalReason: reason,
      },
    });
    if (!count) throw Conflict('This payment is already reversed');
    await undoEffects(tx, actor, payment, `Receipt ${payment.receiptNo} reversed: ${reason}`);
    await auditLog(
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
  return findOne(actor, id);
}

/** Everything the receipt PDF needs. */
export async function receiptData(actor, id) {
  const payment = await findOne(actor, id);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
  return { payment, tenant };
}

/**
 * Opposite ledger row and negative allocation rows for everything still
 * allocated. Old rows are never edited or deleted.
 */
async function undoEffects(tx, actor, payment, narration) {
  const incoming = payment.direction === PaymentDirection.IN;
  await postLedger(tx, {
    tenantId: actor.tenantId,
    partyId: payment.partyId,
    entryDate: nepalToday(),
    type: incoming ? LedgerEntryType.PAYMENT : LedgerEntryType.PURCHASE_PAYMENT,
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
        amount: n._sum.amount.neg(),
      })),
    });
  }
}

async function getCheque(actor, id) {
  const payment = await findOne(actor, id);
  if (payment.method !== PaymentMethod.CHEQUE) throw BadRequest('This payment is not a cheque');
  if (payment.status !== PaymentStatus.ACTIVE || payment.chequeStatus !== ChequeStatus.PENDING) {
    throw Conflict(
      `The cheque is ${payment.chequeStatus}${payment.status === PaymentStatus.REVERSED ? ' (payment reversed)' : ''}`,
    );
  }
  return payment;
}

async function findByClientUuid(actor, clientUuid) {
  const existing = await prisma.payment.findUnique({
    where: { clientUuid },
    include: PAYMENT_DETAIL_INCLUDE,
  });
  if (!existing) return null;
  const visible =
    existing.tenantId === actor.tenantId &&
    (!FIELD_ROLES.includes(actor.role) || existing.collectedById === actor.userId);
  if (!visible) throw Conflict('This clientUuid is already used by another payment');
  return { ...(await withSummary(existing)), idempotentReplay: true };
}

async function withSummary(payment) {
  const allocated = payment.allocations.reduce((s, a) => s.plus(a.amount), new Decimal(0));
  // Balance right after this payment: all ledger rows up to its own.
  const own = await prisma.ledgerEntry.findFirst({
    where: { tenantId: payment.tenantId, refType: PAYMENT_REF, refId: payment.id },
    orderBy: { createdAt: 'asc' },
  });
  const upTo = own
    ? await prisma.ledgerEntry.aggregate({
        where: { tenantId: payment.tenantId, partyId: payment.partyId, createdAt: { lte: own.createdAt } },
        _sum: { debit: true, credit: true },
      })
    : null;
  return {
    ...payment,
    allocatedAmount: allocated,
    unallocatedAmount:
      payment.status === PaymentStatus.ACTIVE ? payment.amount.minus(allocated) : new Decimal(0),
    balanceAfterPayment: upTo
      ? (upTo._sum.debit ?? new Decimal(0)).minus(upTo._sum.credit ?? new Decimal(0))
      : null,
  };
}

function assertChequeFields(dto) {
  const cheque = dto.method === PaymentMethod.CHEQUE;
  const given = [dto.chequeNo, dto.chequeBank, dto.chequeDate];
  if (cheque && given.some((v) => !v)) {
    throw BadRequest('chequeNo, chequeBank and chequeDate are required for CHEQUE');
  }
  if (!cheque && given.some(Boolean)) {
    throw BadRequest('Cheque details are only allowed when method is CHEQUE');
  }
}

export function describeMethod(p) {
  if (p.method === PaymentMethod.CHEQUE) return `Cheque ${p.chequeNo}, ${p.chequeBank}`;
  return p.referenceNo ? `${p.method} ref ${p.referenceNo}` : p.method;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const { OWNER, MANAGER, OFFICE, SALESMAN, DRIVER } = UserRole;
const r = controller('/payments', { roles: [OWNER, MANAGER, OFFICE, SALESMAN, DRIVER] });

// Salesmen/drivers see only what they collected.
r.get('/', { query: ListPaymentsQueryDto }, ({ user, query }) => list(user, query));
r.get('/:id', { params: { id: 'uuid' } }, ({ user, params }) => findOne(user, params.id));
// Receive from a customer: receipt no., allocation (given or FIFO; rest = advance), ledger CREDIT. Idempotent by clientUuid.
r.post('/receive', { body: ReceivePaymentDto }, ({ user, body }) => receive(user, body));
// Pay a supplier: ledger DEBIT (PURCHASE_PAYMENT)
r.post('/pay', { roles: [OWNER, MANAGER, OFFICE], body: PaySupplierDto }, ({ user, body }) =>
  paySupplier(user, body),
);
r.post(
  '/:id/cheque-cleared',
  { roles: [OWNER, MANAGER, OFFICE], status: 200, params: { id: 'uuid' } },
  ({ user, params }) => chequeCleared(user, params.id),
);
// Bounced: ledger and allocations reversed, balance goes back up
r.post(
  '/:id/cheque-bounced',
  { roles: [OWNER, MANAGER, OFFICE], status: 200, params: { id: 'uuid' }, body: ReasonDto },
  ({ user, params, body }) => chequeBounced(user, params.id, body.reason),
);
// Reverse: status REVERSED, reversal ledger row, negative allocations
r.post(
  '/:id/reverse',
  { roles: [OWNER, MANAGER], status: 200, params: { id: 'uuid' }, body: ReasonDto },
  ({ user, params, body }) => reverse(user, params.id, body.reason),
);
// 80 mm thermal receipt
r.get('/:id/receipt-pdf', { params: { id: 'uuid' } }, async ({ user, params, res }) => {
  const data = await receiptData(user, params.id);
  const pdf = await renderReceiptPdf(data);
  sendPdf(res, pdf, `receipt-${data.payment.fiscalYear.replace('/', '-')}-${data.payment.receiptNo}.pdf`);
});

export const paymentsRoutes = r;
