import { HandoverStatus, Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OpenInvoice {
  invoiceId: string;
  invoiceNo: number;
  fiscalYear: string;
  /** UTC-midnight date (as stored for @db.Date). */
  invoiceDate: Date;
  total: Decimal;
  outstanding: Decimal;
}

export interface Allocation {
  invoiceId: string;
  amount: Decimal;
}

// ─── Allocation ──────────────────────────────────────────────────────────────

/**
 * Settles the oldest unpaid invoices first. `invoices` must already be sorted
 * oldest first. Whatever is left over is an unallocated advance.
 */
export function fifoAllocate(
  amount: Decimal,
  invoices: OpenInvoice[],
): { allocations: Allocation[]; advance: Decimal } {
  let left = amount;
  const allocations: Allocation[] = [];
  for (const inv of invoices) {
    if (left.lte(0)) break;
    if (inv.outstanding.lte(0)) continue;
    const take = Decimal.min(left, inv.outstanding);
    allocations.push({ invoiceId: inv.invoiceId, amount: take });
    left = left.minus(take);
  }
  return { allocations, advance: left };
}

/** Problems with allocations the user chose by hand (empty = valid). */
export function checkManualAllocations(
  amount: Decimal,
  requested: Allocation[],
  openById: Map<string, OpenInvoice>,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let sum = new Decimal(0);
  requested.forEach((a, i) => {
    const inv = openById.get(a.invoiceId);
    if (seen.has(a.invoiceId)) errors.push(`[${i}] invoice listed twice`);
    seen.add(a.invoiceId);
    if (!inv) {
      errors.push(
        `[${i}] invoice is not an unpaid, issued invoice of this party`,
      );
    } else if (a.amount.gt(inv.outstanding)) {
      errors.push(
        `[${i}] Rs ${a.amount.toFixed(2)} is more than invoice ${inv.invoiceNo}'s outstanding Rs ${inv.outstanding.toFixed(2)}`,
      );
    }
    sum = sum.plus(a.amount);
  });
  if (sum.gt(amount)) {
    errors.push(
      `Allocations (Rs ${sum.toFixed(2)}) are more than the payment (Rs ${amount.toFixed(2)})`,
    );
  }
  return errors;
}

// ─── Due dates ───────────────────────────────────────────────────────────────

export function dueDate(invoiceDate: Date, creditDays: number): Date {
  return new Date(invoiceDate.getTime() + creditDays * DAY_MS);
}

/** Whole days between two UTC-midnight dates (b - a). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** Overdue: today is past the due date and something is still owed. */
export function isOverdue(
  invoiceDate: Date,
  creditDays: number,
  outstanding: Decimal,
  today: Date,
): boolean {
  return outstanding.gt(0) && today > dueDate(invoiceDate, creditDays);
}

// ─── Ageing ──────────────────────────────────────────────────────────────────

export const AGEING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function ageingBucket(ageDays: number): AgeingBucket {
  if (ageDays <= 30) return '0-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
}

export interface AgeingInput {
  partyId: string;
  creditDays: number;
  invoiceDate: Date;
  outstanding: Decimal;
}

export interface AgeingRow {
  partyId: string;
  total: Decimal;
  buckets: Record<AgeingBucket, Decimal>;
  overdue: Decimal;
  oldestInvoiceDays: number;
}

/** Groups outstanding invoices per party into age buckets (age by invoice date). */
export function buildAgeing(rows: AgeingInput[], asOf: Date): AgeingRow[] {
  const byParty = new Map<string, AgeingRow>();
  for (const r of rows) {
    if (r.outstanding.lte(0) || r.invoiceDate > asOf) continue;
    const row = byParty.get(r.partyId) ?? {
      partyId: r.partyId,
      total: new Decimal(0),
      buckets: Object.fromEntries(
        AGEING_BUCKETS.map((b) => [b, new Decimal(0)]),
      ) as Record<AgeingBucket, Decimal>,
      overdue: new Decimal(0),
      oldestInvoiceDays: 0,
    };
    const age = daysBetween(r.invoiceDate, asOf);
    const bucket = ageingBucket(age);
    row.total = row.total.plus(r.outstanding);
    row.buckets[bucket] = row.buckets[bucket].plus(r.outstanding);
    if (isOverdue(r.invoiceDate, r.creditDays, r.outstanding, asOf)) {
      row.overdue = row.overdue.plus(r.outstanding);
    }
    row.oldestInvoiceDays = Math.max(row.oldestInvoiceDays, age);
    byParty.set(r.partyId, row);
  }
  return [...byParty.values()];
}

// ─── Cash handover ───────────────────────────────────────────────────────────

export function handoverOutcome(expected: Decimal, received: Decimal) {
  const difference = received.minus(expected);
  return {
    status: difference.isZero()
      ? HandoverStatus.VERIFIED
      : HandoverStatus.DISPUTED,
    difference,
  };
}
