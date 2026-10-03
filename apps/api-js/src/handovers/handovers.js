import { handoverOutcome } from '../accounts/accounts-rules.js';
import { auditLog } from '../common/audit.js';
import { getFiscalYear } from '../common/nepali-date.js';
import { nextDocNumber } from '../common/numbering.js';
import { pageArgs, paginationDefaults, paginationFields } from '../common/pagination.js';
import {
  AuditAction,
  Decimal,
  DocType,
  HandoverStatus,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
  UserRole,
  prisma,
} from '../db.js';
import { BadRequest, Conflict, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  arrayMaxSize,
  arrayMinSize,
  isArray,
  isEnum,
  isNumber,
  isString,
  isUuid,
  isUuidEach,
  length,
  max,
  min,
  optional,
  schema,
  trim,
} from '../http/validation.js';
import { MAX_MONEY } from '../pricing/pricing.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const SubmitHandoverDto = schema({
  /** Ids from GET /handovers/my-pending */
  paymentIds: [isArray(), arrayMinSize(1), arrayMaxSize(500), isUuidEach()],
});

const VerifyHandoverDto = schema({
  /** Cash actually counted */
  receivedAmount: [isNumber({ maxDecimalPlaces: 2 }), min(0), max(MAX_MONEY)],
  note: [optional(), trim(), isString(), length(1, 500)],
});

const ListHandoversQueryDto = schema(
  {
    status: [optional(), isEnum(HandoverStatus)],
    /** Ignored for salesmen/drivers (always themselves) */
    fromUserId: [optional(), isUuid()],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

// ─── Service ────────────────────────────────────────────────────────────────

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
};

/** Cash a person collected and still holds: active CASH receipts not yet handed over. */
export function cashInHandWhere(tenantId, userId) {
  return {
    tenantId,
    ...(userId && { collectedById: userId }),
    direction: PaymentDirection.IN,
    method: PaymentMethod.CASH,
    status: PaymentStatus.ACTIVE,
    handoverId: null,
  };
}

function scope(actor) {
  const field = actor.role === UserRole.SALESMAN || actor.role === UserRole.DRIVER;
  return { tenantId: actor.tenantId, ...(field && { fromUserId: actor.userId }) };
}

export async function myPending(actor) {
  const payments = await prisma.payment.findMany({
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
export async function submit(actor, paymentIds) {
  const ids = [...new Set(paymentIds)];
  const payments = await prisma.payment.findMany({
    where: { id: { in: ids }, ...cashInHandWhere(actor.tenantId, actor.userId) },
  });
  if (payments.length !== ids.length) {
    throw BadRequest(
      'Every payment must be your own CASH receipt that is not reversed or already handed over',
    );
  }
  const expected = payments.reduce((s, p) => s.plus(p.amount), new Decimal(0));

  const id = await prisma.$transaction(async (tx) => {
    const fiscalYear = getFiscalYear(new Date());
    const n = await nextDocNumber(tx, actor.tenantId, DocType.HANDOVER, fiscalYear);
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
      where: { id: { in: ids }, ...cashInHandWhere(actor.tenantId, actor.userId) },
      data: { handoverId: handover.id },
    });
    if (count !== ids.length) throw Conflict('Some payments were handed over or reversed meanwhile');
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'CashHandover',
        entityId: handover.id,
        action: AuditAction.CREATE,
        newValue: { handoverNo: handover.handoverNo, expectedAmount: expected, paymentIds: ids },
      },
      tx,
    );
    return handover.id;
  });
  return findOne(actor, id);
}

/** Office counts the cash: VERIFIED if it matches, DISPUTED (difference stored) if not. */
export async function verify(actor, id, receivedAmount, note) {
  const handover = await findOne(actor, id);
  if (handover.status !== HandoverStatus.SUBMITTED) {
    throw Conflict(`This handover is already ${handover.status}`);
  }
  if (handover.fromUserId === actor.userId) throw BadRequest('You cannot verify your own handover');
  const received = new Decimal(receivedAmount);
  const outcome = handoverOutcome(handover.expectedAmount, received);

  await prisma.$transaction(async (tx) => {
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
    if (!count) throw Conflict('This handover was already verified');
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'CashHandover',
        entityId: id,
        action: AuditAction.UPDATE,
        oldValue: { status: HandoverStatus.SUBMITTED, expectedAmount: handover.expectedAmount },
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
  return findOne(actor, id);
}

export async function list(actor, q) {
  const where = {
    ...(q.fromUserId && { fromUserId: q.fromUserId }),
    ...scope(actor),
    status: q.status,
  };
  const [items, total] = await Promise.all([
    prisma.cashHandover.findMany({
      where,
      include: {
        fromUser: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        _count: { select: { payments: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(q),
    }),
    prisma.cashHandover.count({ where }),
  ]);
  return { items, total, page: q.page, limit: q.limit };
}

export async function findOne(actor, id) {
  const handover = await prisma.cashHandover.findFirst({
    where: { id, ...scope(actor) },
    include: DETAIL_INCLUDE,
  });
  if (!handover) throw NotFound('Handover not found');
  return handover;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const { OWNER, MANAGER, OFFICE, SALESMAN, DRIVER } = UserRole;
const r = controller('/handovers');

// My CASH receipts not yet handed over, with total
r.get('/my-pending', { roles: [SALESMAN, DRIVER] }, ({ user }) => myPending(user));
// Hand over cash (SUBMITTED; expectedAmount = sum)
r.post('/', { roles: [SALESMAN, DRIVER], body: SubmitHandoverDto }, ({ user, body }) =>
  submit(user, body.paymentIds),
);
// Count the cash: VERIFIED if equal, DISPUTED with the difference
r.post(
  '/:id/verify',
  { roles: [OWNER, MANAGER, OFFICE], status: 200, params: { id: 'uuid' }, body: VerifyHandoverDto },
  ({ user, params, body }) => verify(user, params.id, body.receivedAmount, body.note),
);
r.get('/', { roles: [OWNER, MANAGER, OFFICE, SALESMAN, DRIVER], query: ListHandoversQueryDto }, ({ user, query }) =>
  list(user, query),
);
r.get('/:id', { roles: [OWNER, MANAGER, OFFICE, SALESMAN, DRIVER], params: { id: 'uuid' } }, ({ user, params }) =>
  findOne(user, params.id),
);

export const handoversRoutes = r;
