import { Prisma } from '../../generated/prisma/client.js';
import { calculateBill } from './bill-totals.js';

const D = (v: number | string) => new Prisma.Decimal(v);
const line = (qty: number, rate: number, discount = 0, vat = true) => ({
  quantity: D(qty),
  rate: D(rate),
  discount: D(discount),
  vatApplicable: vat,
});

describe('calculateBill', () => {
  it('adds 13% VAT on VAT-applicable lines only', () => {
    const t = calculateBill([line(10, 100), line(5, 40, 0, false)], D(0));
    expect(t.subtotal.toFixed(2)).toBe('1200.00');
    expect(t.taxableAmount.toFixed(2)).toBe('1000.00');
    expect(t.exemptAmount.toFixed(2)).toBe('200.00');
    expect(t.vatAmount.toFixed(2)).toBe('130.00');
    expect(t.total.toFixed(2)).toBe('1330.00');
    expect(t.lines.map((l) => l.vatAmount.toFixed(2))).toEqual([
      '130.00',
      '0.00',
    ]);
  });

  it('applies line discounts before VAT', () => {
    const t = calculateBill([line(3, 1000, 300)], D(0));
    expect(t.lines[0].amount.toFixed(2)).toBe('2700.00');
    expect(t.vatAmount.toFixed(2)).toBe('351.00');
    expect(t.total.toFixed(2)).toBe('3051.00');
  });

  it('spreads the bill discount by line amount and taxes only the discounted value', () => {
    const t = calculateBill([line(1, 3000), line(1, 1000, 0, false)], D(400));
    expect(t.lines.map((l) => l.billDiscountShare.toFixed(2))).toEqual([
      '300.00',
      '100.00',
    ]);
    expect(t.lines[0].taxable.toFixed(2)).toBe('2700.00');
    expect(t.vatAmount.toFixed(2)).toBe('351.00');
    expect(t.total.toFixed(2)).toBe('3951.00'); // 4000 - 400 + 351
  });

  it('rounds to paisa and keeps line VAT summing to the bill VAT', () => {
    const t = calculateBill(
      [line(1, 10.01), line(1, 10.01), line(1, 10.01)],
      D(0),
    );
    // 30.03 × 13% = 3.9039 -> 3.90; lines 1.30 + 1.30 + 1.30 = 3.90
    expect(t.vatAmount.toFixed(2)).toBe('3.90');
    const sum = t.lines.reduce((s, l) => s.plus(l.vatAmount), D(0));
    expect(sum.toFixed(2)).toBe('3.90');
  });

  it('uses exact decimals for fractional quantities', () => {
    const t = calculateBill([line(2.5, 80.1)], D(0));
    expect(t.subtotal.toFixed(2)).toBe('200.25');
  });

  it('rejects discounts larger than the amount', () => {
    expect(() => calculateBill([line(1, 100, 101)], D(0))).toThrow(RangeError);
    expect(() => calculateBill([line(1, 100)], D(101))).toThrow(
      'Bill discount is more than the subtotal',
    );
  });
});
