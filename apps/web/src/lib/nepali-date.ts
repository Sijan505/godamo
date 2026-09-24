import ndcModule from "nepali-date-converter";

// The package ships CommonJS + ESM builds; depending on the bundler the default
// import is the class itself or a module object holding it on `.default`.
type NepaliDateClass = typeof ndcModule;
const NepaliDate: NepaliDateClass =
  (ndcModule as unknown as { default?: NepaliDateClass }).default ?? ndcModule;

const NEPAL_TZ = "Asia/Kathmandu";

/** Today's date in Nepal as YYYY-MM-DD (independent of the browser's timezone). */
export function nepalTodayISO(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: NEPAL_TZ });
}

function fromISO(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new NepaliDate(new Date(y, m - 1, d, 12));
}

/** "2083-06-08" for an AD date string "2026-09-24". */
export function isoToBS(iso: string): string {
  return fromISO(iso).format("YYYY-MM-DD");
}

/** "८ असोज २०८३" (Nepali script) for an AD date string. */
export function isoToBSLongNepali(iso: string): string {
  return fromISO(iso).format("D MMMM YYYY", "np");
}

/** "Asoj 8" for chart axes. */
export function isoToBSShort(iso: string): string {
  return fromISO(iso).format("MMMM D");
}

/** "24 Sep 2026" */
export function formatAD(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
