import { after, before, describe, it } from 'node:test';
import { expect } from './expect.js';
import { Prisma } from '../src/db.js';
import { splitLineByBatches } from '../src/invoices/invoices.js';

const D = (v) => new Prisma.Decimal(v);

// 2 box of Dettol (1 box = 12 pcs = 24 pcs), rate 1366.20/box, 2.5% discount.
const line = {
  quantity: D(2),
  baseQty: D(24),
  discount: D('68.31'),
  amount: D('2664.09'),
  vatAmount: D('346.33'),
};

describe('splitLineByBatches (FEFO on invoices)', () => {
  it('keeps a single-batch line as it is', () => {
    const [part] = splitLineByBatches(line, [{ batchId: 'b1', qty: D(24) }]);
    expect(part).toMatchObject({
      batchId: 'b1',
      quantity: D(2),
      baseQuantity: D(24),
    });
    expect(part.amount.toFixed(2)).toBe('2664.09');
  });

  it('splits across batches in proportion and adds back up exactly', () => {
    const parts = splitLineByBatches(line, [
      { batchId: 'soon', qty: D(7) },
      { batchId: 'later', qty: D(17) },
    ]);
    expect(parts.map((p) => [p.batchId, p.baseQuantity.toNumber()])).toEqual([
      ['soon', 7],
      ['later', 17],
    ]);
    // 7/24 of each value, the rest on the last batch
    expect(parts[0].quantity.toString()).toBe('0.583');
    expect(parts[0].amount.toFixed(2)).toBe('777.03');
    const sum = (k) => parts.reduce((s, p) => s.plus(p[k]), D(0)).toString();
    expect(sum('quantity')).toBe('2');
    expect(sum('discount')).toBe('68.31');
    expect(sum('amount')).toBe('2664.09');
    expect(sum('vatAmount')).toBe('346.33');
  });

  it('handles three batches', () => {
    const parts = splitLineByBatches(line, [
      { batchId: 'a', qty: D(5) },
      { batchId: 'b', qty: D(5) },
      { batchId: 'c', qty: D(14) },
    ]);
    expect(parts.reduce((s, p) => s.plus(p.amount), D(0)).toFixed(2)).toBe('2664.09');
    expect(parts.reduce((s, p) => s.plus(p.baseQuantity), D(0)).toString()).toBe('24');
  });
});
