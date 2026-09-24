import { HandoverStatus, Prisma } from '../generated/prisma/client.js';
import {
  ageingBucket,
  buildAgeing,
  checkManualAllocations,
  fifoAllocate,
  handoverOutcome,
  isOverdue,
  type OpenInvoice,
} from './accounts-rules.js';

const D = (v: number | string) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00Z`);

// Oldest first, as unpaidInvoices() returns them.
const open: OpenInvoice[] = [
  {
    invoiceId: 'i1',
    invoiceNo: 1,
    fiscalYear: '2083/84',
    invoiceDate: day('2026-08-01'),
    total: D(5000),
    outstanding: D(3000),
  },
  {
    invoiceId: 'i2',
    invoiceNo: 2,
    fiscalYear: '2083/84',
    invoiceDate: day('2026-08-15'),
    total: D(4000),
    outstanding: D(4000),
  },
  {
    invoiceId: 'i3',
    invoiceNo: 3,
    fiscalYear: '2083/84',
    invoiceDate: day('2026-09-01'),
    total: D(2500),
    outstanding: D(2500),
  },
];
const alloc = (r: {
  allocations: { invoiceId: string; amount: Prisma.Decimal }[];
}) => r.allocations.map((a) => [a.invoiceId, a.amount.toFixed(2)]);

describe('fifoAllocate', () => {
  it('settles the oldest invoices first', () => {
    const r = fifoAllocate(D(7000), open);
    expect(alloc(r)).toEqual([
      ['i1', '3000.00'],
      ['i2', '4000.00'],
    ]);
    expect(r.advance.toFixed(2)).toBe('0.00');
  });

  it('leaves a partly paid invoice when the money runs out (partial payment)', () => {
    const r = fifoAllocate(D(4500), open);
    expect(alloc(r)).toEqual([
      ['i1', '3000.00'],
      ['i2', '1500.00'],
    ]);
  });

  it('keeps anything above all outstanding bills as an advance', () => {
    const r = fifoAllocate(D(10000), open);
    expect(alloc(r)).toHaveLength(3);
    expect(r.advance.toFixed(2)).toBe('500.00');
  });

  it('is all advance when nothing is owed', () => {
    const r = fifoAllocate(D(2000), []);
    expect(r.allocations).toEqual([]);
    expect(r.advance.toFixed(2)).toBe('2000.00');
  });
});

describe('checkManualAllocations', () => {
  const byId = new Map(open.map((o) => [o.invoiceId, o]));

  it('accepts allocations within each outstanding and the payment', () => {
    expect(
      checkManualAllocations(
        D(5000),
        [
          { invoiceId: 'i3', amount: D(2500) },
          { invoiceId: 'i1', amount: D(1000) },
        ],
        byId,
      ),
    ).toEqual([]);
  });

  it('rejects unknown/cancelled invoices, over-allocation, duplicates and totals above the payment', () => {
    const errors = checkManualAllocations(
      D(3000),
      [
        { invoiceId: 'other-party-inv', amount: D(100) },
        { invoiceId: 'i1', amount: D('3000.01') },
        { invoiceId: 'i3', amount: D(100) },
        { invoiceId: 'i3', amount: D(100) },
      ],
      byId,
    );
    expect(errors).toEqual([
      '[0] invoice is not an unpaid, issued invoice of this party',
      "[1] Rs 3000.01 is more than invoice 1's outstanding Rs 3000.00",
      '[3] invoice listed twice',
      'Allocations (Rs 3300.01) are more than the payment (Rs 3000.00)',
    ]);
  });
});

describe('overdue and ageing', () => {
  it('is overdue only after invoice date + credit days, while unpaid', () => {
    const d = day('2026-09-01');
    expect(isOverdue(d, 15, D(100), day('2026-09-16'))).toBe(false); // due today
    expect(isOverdue(d, 15, D(100), day('2026-09-17'))).toBe(true);
    expect(isOverdue(d, 15, D(0), day('2026-12-01'))).toBe(false); // paid
  });

  it('puts invoices into 0-30, 31-60, 61-90 and 90+ day buckets', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(ageingBucket)).toEqual([
      '0-30',
      '0-30',
      '31-60',
      '31-60',
      '61-90',
      '61-90',
      '90+',
      '90+',
    ]);
  });

  it('builds per-party ageing with overdue amounts', () => {
    const asOf = day('2026-12-01');
    const rows = buildAgeing(
      [
        {
          partyId: 'a',
          creditDays: 30,
          invoiceDate: day('2026-11-20'),
          outstanding: D(1000),
        }, // 11 days
        {
          partyId: 'a',
          creditDays: 30,
          invoiceDate: day('2026-10-10'),
          outstanding: D(2000),
        }, // 52 days, overdue
        {
          partyId: 'a',
          creditDays: 30,
          invoiceDate: day('2026-08-01'),
          outstanding: D(500),
        }, // 122 days, overdue
        {
          partyId: 'b',
          creditDays: 90,
          invoiceDate: day('2026-09-15'),
          outstanding: D(700),
        }, // 77 days
        {
          partyId: 'b',
          creditDays: 90,
          invoiceDate: day('2026-12-05'),
          outstanding: D(999),
        }, // after asOf: ignored
        {
          partyId: 'c',
          creditDays: 0,
          invoiceDate: day('2026-11-01'),
          outstanding: D(0),
        }, // paid: ignored
      ],
      asOf,
    );
    const a = rows.find((r) => r.partyId === 'a')!;
    expect(a.total.toFixed(2)).toBe('3500.00');
    expect(
      Object.fromEntries(
        Object.entries(a.buckets).map(([k, v]) => [k, v.toNumber()]),
      ),
    ).toEqual({
      '0-30': 1000,
      '31-60': 2000,
      '61-90': 0,
      '90+': 500,
    });
    expect(a.overdue.toFixed(2)).toBe('2500.00');
    expect(a.oldestInvoiceDays).toBe(122);

    const b = rows.find((r) => r.partyId === 'b')!;
    expect(b.total.toFixed(2)).toBe('700.00');
    expect(b.buckets['61-90'].toNumber()).toBe(700);
    expect(b.overdue.toNumber()).toBe(0); // 77 days < 90 credit days
    expect(rows.find((r) => r.partyId === 'c')).toBeUndefined();
  });
});

describe('handoverOutcome', () => {
  it('verifies when the counted cash matches', () => {
    expect(handoverOutcome(D(15000), D(15000))).toEqual({
      status: HandoverStatus.VERIFIED,
      difference: D(0),
    });
  });

  it('disputes a shortfall or excess and stores the difference', () => {
    const short = handoverOutcome(D(15000), D(14500));
    expect(short.status).toBe(HandoverStatus.DISPUTED);
    expect(short.difference.toFixed(2)).toBe('-500.00');
    expect(handoverOutcome(D(100), D(120)).difference.toFixed(2)).toBe('20.00');
  });
});
