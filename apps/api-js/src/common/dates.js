/** Business dates follow Nepal time (UTC+05:45), not the server's timezone. */
const NEPAL_TZ = 'Asia/Kathmandu';
const NEPAL_OFFSET = '+05:45';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's date in Nepal as "YYYY-MM-DD". */
export function nepalTodayString(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: NEPAL_TZ });
}

/**
 * Today's date in Nepal as a UTC-midnight Date, the same form Prisma returns
 * for @db.Date columns (e.g. batch expiry dates), so the two compare directly.
 */
export function nepalToday(now = new Date()) {
  return new Date(`${nepalTodayString(now)}T00:00:00Z`);
}

/** The instant a Nepal calendar day ("YYYY-MM-DD") starts. */
export function nepalDayStart(date) {
  return new Date(`${date}T00:00:00${NEPAL_OFFSET}`);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

/** "YYYY-MM-DD" -> UTC-midnight Date, for @db.Date columns. */
export function dateOnly(date) {
  return new Date(`${date}T00:00:00Z`);
}
