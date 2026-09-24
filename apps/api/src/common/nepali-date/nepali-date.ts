import ndcModule from 'nepali-date-converter';
import { nepalTodayString } from '../dates.js';

// The package is UMD/CommonJS: under Node ESM the default import is the module
// object (class on `.default`), under Vite/vitest it is the class itself.
type NepaliDateClass = typeof ndcModule.default;
const NepaliDate: NepaliDateClass =
  (ndcModule as unknown as { default?: NepaliDateClass }).default ??
  (ndcModule as unknown as NepaliDateClass);

/** Shrawan is month index 3 (Baisakh = 0); the fiscal year starts on Shrawan 1. */
const SHRAWAN = 3;

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/**
 * The Nepal calendar day an instant falls on, as a NepaliDate. Built from the
 * Nepal (UTC+05:45) calendar date, so the server's own timezone never matters.
 */
function toNepali(adDate: Date): InstanceType<typeof NepaliDate> {
  const [y, m, d] = nepalTodayString(adDate).split('-').map(Number);
  return new NepaliDate(new Date(y, m - 1, d, 12));
}

/** BS date "YYYY-MM-DD", e.g. "2083-06-08". */
export function formatBS(adDate: Date): string {
  const bs = toNepali(adDate).getBS();
  return `${bs.year}-${pad(bs.month + 1)}-${pad(bs.date)}`;
}

/** Nepal fiscal year for a date, e.g. "2083/84". It starts on Shrawan 1 (mid-July). */
export function getFiscalYear(adDate: Date): string {
  const bs = toNepali(adDate).getBS();
  const start = bs.month >= SHRAWAN ? bs.year : bs.year - 1;
  return `${start}/${pad((start + 1) % 100)}`;
}

/** AD date ("YYYY-MM-DD") of a BS date, for tests and date pickers. */
export function bsToAd(year: number, month: number, day: number): string {
  const ad = new NepaliDate(year, month - 1, day).getAD();
  return `${ad.year}-${pad(ad.month + 1)}-${pad(ad.date)}`;
}
