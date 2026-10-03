import { paymentInfo } from '../accounts/outstanding.js';
import { addDays, nepalToday } from '../common/dates.js';
import { formatBS } from '../common/nepali-date.js';
import {
  CreditApprovalStatus,
  Decimal,
  HandoverStatus,
  InvoiceStatus,
  PaymentDirection,
  PaymentStatus,
  UserRole,
  prisma,
} from '../db.js';
import { controller } from '../http/router.js';

const ZERO = new Decimal(0);
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * One row per day for the `days` days ending `today` (oldest first), filling
 * days without sales with 0, and labelling each with its BS date.
 * @param {Array<{ day: Date, total: Decimal }>} totals
 */
export function fillDays(today, days, totals) {
  const byDay = new Map(totals.map((t) => [t.day.toISOString().slice(0, 10), t.total]));
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(today, i - (days - 1));
    const date = d.toISOString().slice(0, 10);
    return { date, dateBS: formatBS(d), total: byDay.get(date) ?? new Decimal(0) };
  });
}

/**
 * Office dashboard numbers. Every figure is a small aggregate query scoped to
 * the caller's tenant; the queries run in parallel.
 */
export async function summary(actor) {
  const t = actor.tenantId;
  const today = nepalToday();
  const todayStr = iso(today);
  const weekStart = addDays(today, -6);

  const [
    sales,
    collections,
    balances,
    overdue,
    lowStock,
    expiring,
    pendingCreditApprovals,
    pendingHandovers,
    last7,
    recent,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: { tenantId: t, status: InvoiceStatus.ISSUED, invoiceDate: today },
      _sum: { total: true },
      _count: true,
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: {
        tenantId: t,
        direction: PaymentDirection.IN,
        status: PaymentStatus.ACTIVE,
        paymentDate: today,
      },
      _sum: { amount: true },
      _count: true,
      orderBy: { method: 'asc' },
    }),
    prisma.ledgerEntry.groupBy({
      by: ['partyId'],
      where: { tenantId: t },
      _sum: { debit: true, credit: true },
    }),
    // Outstanding on invoices past invoice date + party credit days.
    prisma.$queryRaw`
      SELECT SUM(o.outstanding) AS amount FROM (
        SELECT i.total - COALESCE(SUM(a.amount), 0) AS outstanding
        FROM invoices i
        JOIN parties p ON p.id = i.party_id
        LEFT JOIN payment_allocations a ON a.invoice_id = i.id
        WHERE i.tenant_id = ${t} AND i.status = 'ISSUED'
          AND i.invoice_date + p.credit_days < ${todayStr}::date
        GROUP BY i.id
      ) o WHERE o.outstanding > 0`,
    prisma.$queryRaw`
      SELECT COUNT(*) AS n FROM (
        SELECT p.id FROM products p
        LEFT JOIN stock_movements m ON m.product_id = p.id AND m.tenant_id = p.tenant_id
        WHERE p.tenant_id = ${t} AND p.is_active AND p.reorder_level > 0
        GROUP BY p.id
        HAVING COALESCE(SUM(m.quantity), 0) <= p.reorder_level
      ) low`,
    prisma.$queryRaw`
      SELECT COUNT(*) AS n FROM (
        SELECT m.batch_id FROM stock_movements m
        JOIN batches b ON b.id = m.batch_id
        WHERE m.tenant_id = ${t} AND b.expiry_date IS NOT NULL
          AND b.expiry_date <= ${iso(addDays(today, 30))}::date
        GROUP BY m.batch_id
        HAVING SUM(m.quantity) > 0
      ) exp`,
    prisma.creditApproval.count({
      where: { tenantId: t, status: CreditApprovalStatus.PENDING, expiresAt: { gt: new Date() } },
    }),
    prisma.cashHandover.count({ where: { tenantId: t, status: HandoverStatus.SUBMITTED } }),
    prisma.invoice.groupBy({
      by: ['invoiceDate'],
      where: { tenantId: t, status: InvoiceStatus.ISSUED, invoiceDate: { gte: weekStart, lte: today } },
      _sum: { total: true },
    }),
    prisma.invoice.findMany({
      where: { tenantId: t },
      include: { party: { select: { id: true, name: true, creditDays: true } } },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);

  const balanceByParty = balances.map((b) => ({
    partyId: b.partyId,
    balance: (b._sum.debit ?? ZERO).minus(b._sum.credit ?? ZERO),
  }));
  const receivableTotal = balanceByParty.reduce((s, b) => (b.balance.gt(0) ? s.plus(b.balance) : s), ZERO);
  const top = balanceByParty
    .filter((b) => b.balance.gt(0))
    .sort((a, b) => b.balance.comparedTo(a.balance))
    .slice(0, 5);

  const [topParties, over90, recentInfo] = await Promise.all([
    prisma.party.findMany({
      where: { id: { in: top.map((d) => d.partyId) } },
      select: { id: true, name: true, phone: true, creditLimit: true },
    }),
    top.length
      ? prisma.$queryRaw`
          SELECT o.party_id, SUM(o.outstanding) AS amount FROM (
            SELECT i.party_id, i.total - COALESCE(SUM(a.amount), 0) AS outstanding
            FROM invoices i
            LEFT JOIN payment_allocations a ON a.invoice_id = i.id
            WHERE i.tenant_id = ${t} AND i.status = 'ISSUED'
              AND i.party_id = ANY(${top.map((d) => d.partyId)}::text[])
              AND i.invoice_date < ${iso(addDays(today, -90))}::date
            GROUP BY i.id
          ) o WHERE o.outstanding > 0 GROUP BY o.party_id`
      : Promise.resolve([]),
    paymentInfo(prisma, recent, today),
  ]);
  const partyById = new Map(topParties.map((p) => [p.id, p]));
  const over90ByParty = new Map(over90.map((o) => [o.party_id, o.amount]));

  return {
    asOf: todayStr,
    todaySales: { total: sales._sum.total ?? ZERO, invoiceCount: sales._count },
    todayCollections: {
      total: collections.reduce((s, c) => s.plus(c._sum.amount ?? ZERO), ZERO),
      byMethod: collections.map((c) => ({
        method: c.method,
        total: c._sum.amount ?? ZERO,
        count: c._count,
      })),
    },
    receivable: { total: receivableTotal, overdue: overdue[0]?.amount ?? ZERO },
    lowStockCount: Number(lowStock[0]?.n ?? 0),
    expiringSoonCount: Number(expiring[0]?.n ?? 0),
    pendingCreditApprovals,
    pendingHandovers,
    salesLast7Days: fillDays(
      today,
      7,
      last7.map((d) => ({ day: d.invoiceDate, total: d._sum.total ?? ZERO })),
    ),
    topDebtors: top.map((d) => ({
      party: partyById.get(d.partyId),
      balance: d.balance,
      over90Days: over90ByParty.get(d.partyId) ?? ZERO,
    })),
    recentInvoices: recent.map((inv) => {
      const info = recentInfo.get(inv.id);
      return {
        id: inv.id,
        fiscalYear: inv.fiscalYear,
        invoiceNo: inv.invoiceNo,
        invoiceDate: iso(inv.invoiceDate),
        party: { id: inv.party.id, name: inv.party.name },
        total: inv.total,
        status: inv.status,
        outstanding: info.outstanding,
        paymentStatus:
          inv.status === InvoiceStatus.CANCELLED
            ? 'CANCELLED'
            : info.outstanding.lte(0)
              ? 'PAID'
              : info.paidAmount.gt(0)
                ? 'PARTIAL'
                : 'UNPAID',
        isOverdue: info.isOverdue,
      };
    }),
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const r = controller('/dashboard', { roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE] });

// Today's sales and collections, receivable/overdue, stock alerts, pending
// approvals and handovers, 7-day sales, top debtors, recent invoices
r.get('/summary', ({ user }) => summary(user));

export const dashboardRoutes = r;
