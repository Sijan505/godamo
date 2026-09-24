import {
  CreditApprovalStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;

/** Managers may decide approvals strictly below this amount; above it only the owner. */
export const MANAGER_APPROVAL_LIMIT = new Prisma.Decimal(50_000);

export type CreditBlockCode = 'CREDIT_LIMIT_EXCEEDED' | 'OVERDUE_INVOICES';

export interface OverdueInvoiceSummary {
  invoiceId: string;
  invoiceNo: number;
  fiscalYear: string;
  invoiceDate: Date;
  dueDate: Date;
  daysOverdue: number;
  outstanding: Decimal;
}

export interface CreditDecision {
  allowed: boolean;
  /** Why billing is blocked (overdue bills are reported first), or null. */
  code: CreditBlockCode | null;
  limitExceeded: boolean;
  balance: Decimal;
  creditLimit: Decimal;
  amount: Decimal;
  newBalance: Decimal;
  /** Invoices overdue beyond the grace period (only when they block). */
  overdueInvoices: OverdueInvoiceSummary[];
}

/**
 * Billing `amount` is allowed while balance + amount stays within the credit
 * limit (a limit of 0 means cash only: any positive balance is blocked) and,
 * when `blockOnOverdue` is on, the party has no bill overdue past the grace
 * period. A credit approval can override either block.
 */
export function evaluateCredit(
  balance: Decimal,
  creditLimit: Decimal,
  amount: Decimal,
  overdueInvoices: OverdueInvoiceSummary[] = [],
  blockOnOverdue = false,
): CreditDecision {
  const newBalance = balance.plus(amount);
  const limitExceeded = newBalance.gt(creditLimit);
  const overdueBlocks = blockOnOverdue && overdueInvoices.length > 0;
  const code: CreditBlockCode | null = overdueBlocks
    ? 'OVERDUE_INVOICES'
    : limitExceeded
      ? 'CREDIT_LIMIT_EXCEEDED'
      : null;
  return {
    allowed: code === null,
    code,
    limitExceeded,
    balance,
    creditLimit,
    amount,
    newBalance,
    overdueInvoices: overdueBlocks ? overdueInvoices : [],
  };
}

/** Why an approval can't be used for this invoice, or null if it can. */
export function approvalProblem(
  approval: {
    status: CreditApprovalStatus;
    partyId: string;
    amount: Decimal;
    expiresAt: Date;
  },
  invoice: { partyId: string; total: Decimal },
  now = new Date(),
): string | null {
  switch (approval.status) {
    case CreditApprovalStatus.PENDING:
      return 'The credit approval is still pending';
    case CreditApprovalStatus.REJECTED:
      return 'The credit approval was rejected';
    case CreditApprovalStatus.USED:
      return 'The credit approval has already been used for another invoice';
  }
  if (approval.partyId !== invoice.partyId) {
    return 'The credit approval is for a different party';
  }
  if (approval.expiresAt <= now) return 'The credit approval has expired';
  if (invoice.total.gt(approval.amount)) {
    return `The credit approval covers up to Rs ${approval.amount.toFixed(2)}, this invoice is Rs ${invoice.total.toFixed(2)}`;
  }
  return null;
}

/** Why this user can't approve/reject the request, or null if they can. */
export function decisionProblem(
  actor: { userId: string; role: UserRole },
  request: { amount: Decimal; requestedById: string },
): string | null {
  if (actor.role === UserRole.OWNER) return null;
  if (actor.role !== UserRole.MANAGER) {
    return 'Only an owner or manager can decide credit approvals';
  }
  if (!request.amount.lt(MANAGER_APPROVAL_LIMIT)) {
    return `Only the owner can decide approvals of Rs ${MANAGER_APPROVAL_LIMIT.toFixed(0)} or more`;
  }
  if (request.requestedById === actor.userId) {
    return 'A manager cannot decide their own request';
  }
  return null;
}
