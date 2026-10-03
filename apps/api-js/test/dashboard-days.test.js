import { after, before, describe, it } from 'node:test';
import { expect } from './expect.js';
import { Prisma } from '../src/db.js';
import { fillDays } from '../src/dashboard/dashboard.js';

const day = (s) => new Date(`${s}T00:00:00Z`);

describe('fillDays (sales last 7 days)', () => {
  it('returns 7 days oldest first with BS dates, filling gaps with 0', () => {
    const rows = fillDays(day('2026-09-24'), 7, [
      { day: day('2026-09-24'), total: new Prisma.Decimal('1500.50') },
      { day: day('2026-09-20'), total: new Prisma.Decimal(700) },
      { day: day('2026-09-10'), total: new Prisma.Decimal(999) }, // outside the window
    ]);
    expect(rows.map((r) => [r.date, r.dateBS, r.total.toString()])).toEqual([
      ['2026-09-18', '2083-06-02', '0'],
      ['2026-09-19', '2083-06-03', '0'],
      ['2026-09-20', '2083-06-04', '700'],
      ['2026-09-21', '2083-06-05', '0'],
      ['2026-09-22', '2083-06-06', '0'],
      ['2026-09-23', '2083-06-07', '0'],
      ['2026-09-24', '2083-06-08', '1500.5'],
    ]);
  });
});
