import { addDays } from '../common/dates.js';
import { formatBS } from '../common/nepali-date/nepali-date.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * One row per day for the `days` days ending `today` (oldest first), filling
 * days without sales with 0, and labelling each with its BS date.
 */
export function fillDays(
  today: Date,
  days: number,
  totals: { day: Date; total: Prisma.Decimal }[],
) {
  const byDay = new Map(
    totals.map((t) => [t.day.toISOString().slice(0, 10), t.total]),
  );
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(today, i - (days - 1));
    const date = d.toISOString().slice(0, 10);
    return {
      date,
      dateBS: formatBS(d),
      total: byDay.get(date) ?? new Prisma.Decimal(0),
    };
  });
}
