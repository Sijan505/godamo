import { AGEING_BUCKETS, buildAgeing } from '../accounts/accounts-rules.js';
import { dateOnly as toDateOnly, nepalToday, nepalTodayString } from '../common/dates.js';
import { ChequeStatus, Decimal, HandoverStatus, PaymentDirection, PaymentStatus, UserRole, prisma } from '../db.js';
import { cashInHandWhere } from '../handovers/handovers.js';
import { controller } from '../http/router.js';
import { dateOnly, isIn, optional, schema } from '../http/validation.js';

// ─── Request queries ────────────────────────────────────────────────────────

const AgeingQueryDto = schema({
  /** Age invoices as of this date (default today) */
  asOf: [optional(), dateOnly()],
  sort: [optional(), isIn(['total', '90plus'])],
});

const DateRangeQueryDto = schema({
  /** Default: today */
  from: [optional(), dateOnly()],
  /** Default: today */
  to: [optional(), dateOnly()],
});

// ─── Service ────────────────────────────────────────────────────────────────

const ZERO = new Decimal(0);
const sum = (values) => values.reduce((s, v) => s.plus(v ?? ZERO), ZERO);

/**
 * Receivable ageing per customer from outstanding invoices, bucketed by
 * invoice age (0-30, 31-60, 61-90, 90+ days) as of `asOf`. `ledgerBalance`
 * also includes opening balances and unallocated advances.
 */
export async function ageing(actor, q) {
  const asOf = q.asOf ? toDateOnly(q.asOf) : nepalToday();
  const asOfStr = asOf.toISOString().slice(0, 10);
  const rows = await prisma.$queryRaw`
    SELECT i.party_id, i.invoice_date, p.credit_days,
           i.total - COALESCE(SUM(a.amount), 0) AS outstanding
    FROM invoices i
    JOIN parties p ON p.id = i.party_id
    LEFT JOIN payment_allocations a ON a.invoice_id = i.id
    WHERE i.tenant_id = ${actor.tenantId} AND i.status = 'ISSUED'
      AND i.invoice_date <= ${asOfStr}::date
    GROUP BY i.id, p.credit_days
    HAVING i.total - COALESCE(SUM(a.amount), 0) > 0`;

  const aged = buildAgeing(
    rows.map((r) => ({
      partyId: r.party_id,
      creditDays: r.credit_days,
      invoiceDate: r.invoice_date,
      outstanding: r.outstanding,
    })),
    asOf,
  );
  const partyIds = aged.map((a) => a.partyId);
  const [parties, balanceMap] = await Promise.all([
    prisma.party.findMany({
      where: { id: { in: partyIds } },
      select: { id: true, name: true, phone: true, creditLimit: true, creditDays: true },
    }),
    balances(actor.tenantId, partyIds),
  ]);
  const partyById = new Map(parties.map((p) => [p.id, p]));

  const items = aged
    .map((a) => ({
      party: partyById.get(a.partyId),
      total: a.total,
      buckets: a.buckets,
      overdue: a.overdue,
      oldestInvoiceDays: a.oldestInvoiceDays,
      creditLimit: partyById.get(a.partyId).creditLimit,
      ledgerBalance: balanceMap.get(a.partyId) ?? ZERO,
    }))
    .sort((x, y) =>
      q.sort === '90plus'
        ? y.buckets['90+'].comparedTo(x.buckets['90+']) || y.total.comparedTo(x.total)
        : y.total.comparedTo(x.total),
    );

  return {
    asOf: asOfStr,
    buckets: AGEING_BUCKETS,
    totals: {
      total: sum(items.map((i) => i.total)),
      overdue: sum(items.map((i) => i.overdue)),
      ...Object.fromEntries(AGEING_BUCKETS.map((b) => [b, sum(items.map((i) => i.buckets[b]))])),
    },
    items,
  };
}

/** Receivable and payable totals from party ledger balances, plus the top 10 debtors. */
export async function outstanding(actor) {
  const balanceMap = await balances(actor.tenantId);
  let receivable = ZERO;
  let payable = ZERO;
  for (const b of balanceMap.values()) {
    if (b.gt(0)) receivable = receivable.plus(b);
    else payable = payable.plus(b.neg());
  }
  const top = [...balanceMap.entries()]
    .filter(([, b]) => b.gt(0))
    .sort(([, a], [, b]) => b.comparedTo(a))
    .slice(0, 10);
  const parties = await prisma.party.findMany({
    where: { id: { in: top.map(([id]) => id) } },
    select: { id: true, name: true, phone: true, type: true, creditLimit: true },
  });
  const byId = new Map(parties.map((p) => [p.id, p]));
  return {
    totalReceivable: receivable,
    totalPayable: payable,
    net: receivable.minus(payable),
    topDebtors: top.map(([id, balance]) => ({ party: byId.get(id), balance })),
  };
}

/** Money received (active receipts) by method, by collector and by day. */
export async function collections(actor, q) {
  const from = q.from ?? nepalTodayString();
  const to = q.to ?? nepalTodayString();
  const where = {
    tenantId: actor.tenantId,
    direction: PaymentDirection.IN,
    status: PaymentStatus.ACTIVE,
    paymentDate: { gte: toDateOnly(from), lte: toDateOnly(to) },
  };
  const [byMethod, byCollector, byDay, pendingCheques] = await Promise.all([
    prisma.payment.groupBy({
      by: ['method'],
      where,
      _sum: { amount: true },
      _count: true,
      orderBy: { method: 'asc' },
    }),
    prisma.payment.groupBy({ by: ['collectedById'], where, _sum: { amount: true }, _count: true }),
    prisma.payment.groupBy({
      by: ['paymentDate'],
      where,
      _sum: { amount: true },
      _count: true,
      orderBy: { paymentDate: 'asc' },
    }),
    prisma.payment.aggregate({
      where: { ...where, chequeStatus: ChequeStatus.PENDING },
      _sum: { amount: true },
      _count: true,
    }),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: byCollector.map((c) => c.collectedById) } },
    select: { id: true, name: true, role: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));
  return {
    from,
    to,
    total: sum(byMethod.map((m) => m._sum.amount)),
    count: byMethod.reduce((n, m) => n + m._count, 0),
    pendingCheques: { amount: pendingCheques._sum.amount ?? ZERO, count: pendingCheques._count },
    byMethod: byMethod.map((m) => ({ method: m.method, amount: m._sum.amount ?? ZERO, count: m._count })),
    byCollector: byCollector
      .map((c) => ({
        collector: userById.get(c.collectedById),
        amount: c._sum.amount ?? ZERO,
        count: c._count,
      }))
      .sort((a, b) => b.amount.comparedTo(a.amount)),
    byDay: byDay.map((d) => ({
      date: d.paymentDate.toISOString().slice(0, 10),
      amount: d._sum.amount ?? ZERO,
      count: d._count,
    })),
  };
}

/**
 * Cash each person holds: CASH receipts not yet handed over, plus handovers
 * submitted but not yet counted, plus shortfalls from disputed handovers.
 */
export async function cashInHand(actor) {
  const [held, inTransit, disputed] = await Promise.all([
    prisma.payment.groupBy({
      by: ['collectedById'],
      where: cashInHandWhere(actor.tenantId),
      _sum: { amount: true },
      _count: true,
    }),
    prisma.cashHandover.groupBy({
      by: ['fromUserId'],
      where: { tenantId: actor.tenantId, status: HandoverStatus.SUBMITTED },
      _sum: { expectedAmount: true },
      _count: true,
    }),
    prisma.cashHandover.groupBy({
      by: ['fromUserId'],
      where: { tenantId: actor.tenantId, status: HandoverStatus.DISPUTED, difference: { lt: 0 } },
      _sum: { difference: true },
    }),
  ]);
  const userIds = [
    ...new Set([
      ...held.map((h) => h.collectedById),
      ...inTransit.map((t) => t.fromUserId),
      ...disputed.map((d) => d.fromUserId),
    ]),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, role: true, phone: true },
  });
  const items = users
    .map((u) => {
      const h = held.find((x) => x.collectedById === u.id);
      const t = inTransit.find((x) => x.fromUserId === u.id);
      const d = disputed.find((x) => x.fromUserId === u.id);
      return {
        user: u,
        cashInHand: h?._sum.amount ?? ZERO,
        receipts: h?._count ?? 0,
        submittedNotVerified: t?._sum.expectedAmount ?? ZERO,
        handoversPending: t?._count ?? 0,
        disputedShortfall: d?._sum.difference?.neg() ?? ZERO,
      };
    })
    .sort((a, b) => b.cashInHand.comparedTo(a.cashInHand));
  return {
    totalCashInHand: sum(items.map((i) => i.cashInHand)),
    totalSubmittedNotVerified: sum(items.map((i) => i.submittedNotVerified)),
    items,
  };
}

/** Ledger balance per party (debit - credit). */
async function balances(tenantId, partyIds) {
  const rows = await prisma.ledgerEntry.groupBy({
    by: ['partyId'],
    where: { tenantId, ...(partyIds && { partyId: { in: partyIds } }) },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r.partyId, (r._sum.debit ?? ZERO).minus(r._sum.credit ?? ZERO)]));
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const r = controller('/reports', { roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE] });

// Receivable ageing per customer (0-30, 31-60, 61-90, 90+ days)
r.get('/ageing', { query: AgeingQueryDto }, ({ user, query }) => ageing(user, query));
// Total receivable, total payable, top 10 debtors
r.get('/outstanding', ({ user }) => outstanding(user));
// Receipts by method, by collector and by day
r.get('/collections', { query: DateRangeQueryDto }, ({ user, query }) => collections(user, query));
// Cash each person holds (not handed over / not yet verified)
r.get('/cash-in-hand', ({ user }) => cashInHand(user));

export const reportsRoutes = r;
