/**
 * Receivable maths, all derived from append-only rows:
 * party balance = SUM(debit) - SUM(credit) of ledger entries;
 * invoice outstanding = total - SUM(payment allocations).
 * Every function takes `db`: the Prisma client or a transaction.
 */
import { nepalToday } from '../common/dates.js';
import { Decimal, InvoiceStatus } from '../db.js';
import { daysBetween, dueDate, isOverdue } from './accounts-rules.js';

export async function partyBalance(db, tenantId, partyId) {
  const sums = await db.ledgerEntry.aggregate({
    where: { tenantId, partyId },
    _sum: { debit: true, credit: true },
  });
  return (sums._sum.debit ?? new Decimal(0)).minus(sums._sum.credit ?? new Decimal(0));
}

/**
 * Paid amount, outstanding, due date and overdue flag for each invoice.
 * @param {Array<{ id: string, total: Decimal, status: string, invoiceDate: Date,
 *   party: { creditDays: number } }>} invoices
 * @returns {Promise<Map<string, { paidAmount: Decimal, outstanding: Decimal,
 *   dueDate: Date, isOverdue: boolean, daysOverdue: number }>>}
 */
export async function paymentInfo(db, invoices, today = nepalToday()) {
  const paid = await paidByInvoice(
    db,
    invoices.map((i) => i.id),
  );
  return new Map(
    invoices.map((inv) => {
      const paidAmount = paid.get(inv.id) ?? new Decimal(0);
      // A cancelled invoice is owed nothing.
      const outstanding =
        inv.status === InvoiceStatus.CANCELLED ? new Decimal(0) : inv.total.minus(paidAmount);
      const due = dueDate(inv.invoiceDate, inv.party.creditDays);
      const overdue = isOverdue(inv.invoiceDate, inv.party.creditDays, outstanding, today);
      return [
        inv.id,
        {
          paidAmount,
          outstanding,
          dueDate: due,
          isOverdue: overdue,
          daysOverdue: overdue ? daysBetween(due, today) : 0,
        },
      ];
    }),
  );
}

export async function paidByInvoice(db, invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = await db.paymentAllocation.groupBy({
    by: ['invoiceId'],
    where: { invoiceId: { in: invoiceIds } },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.invoiceId, r._sum.amount ?? new Decimal(0)]));
}

/** Issued invoices of a party with something still owed, oldest first. */
export async function unpaidInvoices(db, tenantId, partyId) {
  const rows = await db.$queryRaw`
    SELECT i.id, i.invoice_no, i.fiscal_year, i.invoice_date, i.total,
           i.total - COALESCE(SUM(a.amount), 0) AS outstanding, p.credit_days
    FROM invoices i
    JOIN parties p ON p.id = i.party_id
    LEFT JOIN payment_allocations a ON a.invoice_id = i.id
    WHERE i.tenant_id = ${tenantId} AND i.party_id = ${partyId}
      AND i.status = 'ISSUED'
    GROUP BY i.id, p.credit_days
    HAVING i.total - COALESCE(SUM(a.amount), 0) > 0
    ORDER BY i.invoice_date, i.created_at, i.invoice_no`;
  return rows.map((r) => ({
    invoiceId: r.id,
    invoiceNo: r.invoice_no,
    fiscalYear: r.fiscal_year,
    invoiceDate: r.invoice_date,
    total: r.total,
    outstanding: r.outstanding,
    creditDays: r.credit_days,
  }));
}

/** Unpaid invoices more than `graceDays` past their due date. */
export async function overdueInvoices(db, tenantId, partyId, graceDays = 0, today = nepalToday()) {
  const unpaid = await unpaidInvoices(db, tenantId, partyId);
  return unpaid.flatMap((inv) => {
    const due = dueDate(inv.invoiceDate, inv.creditDays);
    const daysOverdue = daysBetween(due, today);
    return daysOverdue > graceDays ? [{ ...inv, dueDate: due, daysOverdue }] : [];
  });
}
