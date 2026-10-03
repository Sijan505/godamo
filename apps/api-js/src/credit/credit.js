import { overdueInvoices, partyBalance } from '../accounts/outstanding.js';
import { getSettings } from '../accounts/settings.js';
import { auditLog } from '../common/audit.js';
import { addDays, nepalDayStart, nepalTodayString } from '../common/dates.js';
import { pageArgs, paginationDefaults, paginationFields } from '../common/pagination.js';
import { AuditAction, CreditApprovalStatus, Decimal, PartyType, UserRole, prisma } from '../db.js';
import { BadRequest, Conflict, Forbidden, HttpError, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  isEnum,
  isNumber,
  isPositive,
  isString,
  isUuid,
  length,
  max,
  optional,
  schema,
  trim,
} from '../http/validation.js';
import { MAX_MONEY } from '../pricing/pricing.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const RequestCreditApprovalDto = schema({
  partyId: [isUuid()],
  /** Largest invoice total this approval may cover */
  amount: [isNumber({ maxDecimalPlaces: 2 }), isPositive(), max(MAX_MONEY)],
  reason: [trim(), isString(), length(3, 500)],
});

const DecideCreditApprovalDto = schema({
  note: [optional(), trim(), isString(), length(1, 500)],
});

const ListCreditApprovalsQueryDto = schema(
  {
    status: [optional(), isEnum(CreditApprovalStatus)],
    partyId: [optional(), isUuid()],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

// ─── Rules ──────────────────────────────────────────────────────────────────

/** Managers may decide approvals strictly below this amount; above it only the owner. */
export const MANAGER_APPROVAL_LIMIT = new Decimal(50_000);

/**
 * Billing `amount` is allowed while balance + amount stays within the credit
 * limit (a limit of 0 means cash only: any positive balance is blocked) and,
 * when `blockOnOverdue` is on, the party has no bill overdue past the grace
 * period. A credit approval can override either block.
 *
 * `code` says why billing is blocked ('OVERDUE_INVOICES' is reported before
 * 'CREDIT_LIMIT_EXCEEDED'), or is null. `overdueInvoices` is only filled when
 * they block.
 */
export function evaluateCredit(balance, creditLimit, amount, overdue = [], blockOnOverdue = false) {
  const newBalance = balance.plus(amount);
  const limitExceeded = newBalance.gt(creditLimit);
  const overdueBlocks = blockOnOverdue && overdue.length > 0;
  const code = overdueBlocks ? 'OVERDUE_INVOICES' : limitExceeded ? 'CREDIT_LIMIT_EXCEEDED' : null;
  return {
    allowed: code === null,
    code,
    limitExceeded,
    balance,
    creditLimit,
    amount,
    newBalance,
    overdueInvoices: overdueBlocks ? overdue : [],
  };
}

/** Why an approval can't be used for this invoice, or null if it can. */
export function approvalProblem(approval, invoice, now = new Date()) {
  switch (approval.status) {
    case CreditApprovalStatus.PENDING:
      return 'The credit approval is still pending';
    case CreditApprovalStatus.REJECTED:
      return 'The credit approval was rejected';
    case CreditApprovalStatus.USED:
      return 'The credit approval has already been used for another invoice';
  }
  if (approval.partyId !== invoice.partyId) return 'The credit approval is for a different party';
  if (approval.expiresAt <= now) return 'The credit approval has expired';
  if (invoice.total.gt(approval.amount)) {
    return `The credit approval covers up to Rs ${approval.amount.toFixed(2)}, this invoice is Rs ${invoice.total.toFixed(2)}`;
  }
  return null;
}

/** Why this user can't approve/reject the request, or null if they can. */
export function decisionProblem(actor, request) {
  if (actor.role === UserRole.OWNER) return null;
  if (actor.role !== UserRole.MANAGER) return 'Only an owner or manager can decide credit approvals';
  if (!request.amount.lt(MANAGER_APPROVAL_LIMIT)) {
    return `Only the owner can decide approvals of Rs ${MANAGER_APPROVAL_LIMIT.toFixed(0)} or more`;
  }
  if (request.requestedById === actor.userId) return 'A manager cannot decide their own request';
  return null;
}

/**
 * Thrown by invoicing when credit is blocked; HTTP 409 with the numbers (and
 * the overdue bills) so the UI can offer "Request approval".
 */
export function creditBlocked(partyName, d) {
  const numbers = {
    balance: d.balance.toFixed(2),
    creditLimit: d.creditLimit.toFixed(2),
    invoiceTotal: d.amount.toFixed(2),
    balanceAfterInvoice: d.newBalance.toFixed(2),
  };
  if (d.code === 'OVERDUE_INVOICES') {
    return new HttpError(409, {
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
  }
  return new HttpError(409, {
    statusCode: 409,
    code: 'CREDIT_LIMIT_EXCEEDED',
    message:
      `Credit limit exceeded for ${partyName}: balance Rs ${d.balance.toFixed(2)} + ` +
      `invoice Rs ${d.amount.toFixed(2)} is more than the limit of Rs ${d.creditLimit.toFixed(2)}. ` +
      'Request a credit approval to continue.',
    ...numbers,
  });
}

function approvalInvalid(message) {
  return new HttpError(409, { statusCode: 409, code: 'CREDIT_APPROVAL_INVALID', message });
}

// ─── Service ────────────────────────────────────────────────────────────────

const APPROVAL_INCLUDE = {
  party: { select: { id: true, name: true, creditLimit: true } },
  requestedBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
};

export async function checkCredit(db, tenantId, party, amount) {
  const [balance, settings] = await Promise.all([
    partyBalance(db, tenantId, party.id),
    getSettings(db, tenantId),
  ]);
  const overdue = settings.blockOnOverdue
    ? await overdueInvoices(db, tenantId, party.id, settings.overdueGraceDays)
    : [];
  return evaluateCredit(balance, party.creditLimit, amount, overdue, settings.blockOnOverdue);
}

export async function creditSummary(actor, partyId) {
  const party = await getParty(actor, partyId);
  const balance = await partyBalance(prisma, actor.tenantId, partyId);
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
export async function assertApprovalUsable(tx, actor, approvalId, invoice) {
  const approval = await tx.creditApproval.findFirst({
    where: { id: approvalId, tenantId: actor.tenantId },
  });
  if (!approval) throw BadRequest('Credit approval not found');
  const problem = approvalProblem(approval, invoice);
  if (problem) throw approvalInvalid(problem);
}

/**
 * Marks the approval USED by this invoice, in the invoice's transaction.
 * The conditional update means one approval can never cover two invoices.
 */
export async function markApprovalUsed(tx, approvalId, invoiceId) {
  const { count } = await tx.creditApproval.updateMany({
    where: { id: approvalId, status: CreditApprovalStatus.APPROVED },
    data: { status: CreditApprovalStatus.USED, usedByInvoiceId: invoiceId },
  });
  if (!count) throw approvalInvalid('The credit approval has already been used for another invoice');
}

export async function requestApproval(actor, dto) {
  const party = await getParty(actor, dto.partyId);
  const balance = await partyBalance(prisma, actor.tenantId, party.id);
  // Valid until the end of the Nepal day it was requested.
  const expiresAt = addDays(nepalDayStart(nepalTodayString()), 1);

  const approval = await prisma.$transaction(async (tx) => {
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
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'CreditApproval',
        entityId: created.id,
        action: AuditAction.CREATE,
        newValue: { partyId: party.id, amount: dto.amount, reason: dto.reason, balance },
      },
      tx,
    );
    return created;
  });
  return { ...approval, currentBalance: balance.toFixed(2) };
}

export async function listApprovals(actor, q) {
  const where = { tenantId: actor.tenantId, status: q.status, partyId: q.partyId };
  const [rows, total] = await Promise.all([
    prisma.creditApproval.findMany({
      where,
      include: APPROVAL_INCLUDE,
      orderBy: { createdAt: 'desc' },
      ...pageArgs(q),
    }),
    prisma.creditApproval.count({ where }),
  ]);
  const now = new Date();
  return {
    items: rows.map((r) => ({ ...r, expired: r.expiresAt <= now })),
    total,
    page: q.page,
    limit: q.limit,
  };
}

async function decide(actor, id, status, note) {
  const request = await prisma.creditApproval.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!request) throw NotFound('Credit approval not found');
  const problem = decisionProblem(actor, request);
  if (problem) throw Forbidden(problem);
  if (request.status !== CreditApprovalStatus.PENDING) {
    throw Conflict(`This request is already ${request.status}`);
  }
  if (request.expiresAt <= new Date()) throw Conflict('This request has expired; ask for a new one');

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.creditApproval.updateMany({
      where: { id, status: CreditApprovalStatus.PENDING },
      data: { status, approvedById: actor.userId, decidedAt: new Date(), decisionNote: note },
    });
    if (!count) throw Conflict('This request was already decided');
    await auditLog(
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
    return tx.creditApproval.findUniqueOrThrow({ where: { id }, include: APPROVAL_INCLUDE });
  });
}

async function getParty(actor, partyId) {
  const party = await prisma.party.findFirst({ where: { id: partyId, tenantId: actor.tenantId } });
  if (!party) throw NotFound('Party not found');
  if (party.type === PartyType.SUPPLIER) throw BadRequest(`${party.name} is not a customer`);
  return party;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const { OWNER, MANAGER, OFFICE, SALESMAN } = UserRole;

const parties = controller('/parties');
// Party balance (from the ledger), credit limit and what is left
parties.get('/:id/credit', { roles: [OWNER, MANAGER, OFFICE, SALESMAN], params: { id: 'uuid' } }, ({ user, params }) =>
  creditSummary(user, params.id),
);

const approvals = controller('/credit-approvals');
approvals.get('/', { roles: [OWNER, MANAGER, OFFICE], query: ListCreditApprovalsQueryDto }, ({ user, query }) =>
  listApprovals(user, query),
);
// Ask the owner to allow ONE invoice over the credit limit (valid until end of today)
approvals.post('/', { roles: [OFFICE, MANAGER], body: RequestCreditApprovalDto }, ({ user, body }) =>
  requestApproval(user, body),
);
// Approve (owner; manager only below Rs 50,000 and not their own request)
approvals.post(
  '/:id/approve',
  { roles: [OWNER, MANAGER], status: 200, params: { id: 'uuid' }, body: DecideCreditApprovalDto },
  ({ user, params, body }) => decide(user, params.id, CreditApprovalStatus.APPROVED, body.note),
);
approvals.post(
  '/:id/reject',
  { roles: [OWNER, MANAGER], status: 200, params: { id: 'uuid' }, body: DecideCreditApprovalDto },
  ({ user, params, body }) => decide(user, params.id, CreditApprovalStatus.REJECTED, body.note),
);

export const creditRoutes = [parties, approvals];
