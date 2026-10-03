// nepali-date-converter is loaded as a classic script (window.NepaliDate).
const NepaliDate = window.NepaliDate.default;

const NEPAL_TZ = 'Asia/Kathmandu';

/** Today's date in Nepal as YYYY-MM-DD (independent of the browser's timezone). */
export function nepalTodayISO(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: NEPAL_TZ });
}

function fromISO(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new NepaliDate(new Date(y, m - 1, d, 12));
}

/** "2083-06-08" for an AD date string "2026-09-24". */
export function isoToBS(iso) {
  return fromISO(iso).format('YYYY-MM-DD');
}

/** "८ असोज २०८३" (Nepali script) for an AD date string. */
export function isoToBSLongNepali(iso) {
  return fromISO(iso).format('D MMMM YYYY', 'np');
}

/** "Asoj 8" for chart axes. */
export function isoToBSShort(iso) {
  return fromISO(iso).format('MMMM D');
}

/** "24 Sep 2026" */
export function formatAD(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
