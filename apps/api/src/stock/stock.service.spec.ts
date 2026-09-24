import { MovementType, Prisma } from '../generated/prisma/client.js';
import {
  InsufficientStockException,
  type MovementInput,
  StockService,
} from './stock.service.js';

const D = (v: number | string) => new Prisma.Decimal(v);
const T = 'tenant-1';
const MAIN = 'godown-main';
const USER = 'user-1';

const PCS_UNITS = [
  { name: 'pcs', factor: D(1) },
  { name: 'box', factor: D(12) },
  { name: 'carton', factor: D(144) },
];

interface Row {
  id: string;
  tenantId: string;
  godownId: string;
  productId: string;
  batchId: string | null;
  type: MovementType;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  refType: string;
  refId: string;
  reversalOfId?: string;
  createdAt: Date;
}

/** Minimal in-memory stand-in for the Prisma calls the stock engine makes. */
function fakeTx() {
  const rows: Row[] = [];
  const locks: string[] = [];
  let seq = 0;
  const products = [
    {
      id: 'soap',
      tenantId: T,
      name: 'Lifebuoy Soap',
      trackBatch: false,
      units: PCS_UNITS,
    },
    {
      id: 'dettol',
      tenantId: T,
      name: 'Dettol 125ml',
      trackBatch: true,
      units: PCS_UNITS,
    },
  ];
  const godowns = [{ id: MAIN, tenantId: T, name: 'Main Godown' }];
  const batches = [
    {
      id: 'b-expired',
      batchNo: 'EXP',
      expiryDate: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date(1),
    },
    {
      id: 'b-late',
      batchNo: 'LATE',
      expiryDate: new Date('2027-06-30T00:00:00Z'),
      createdAt: new Date(2),
    },
    {
      id: 'b-soon',
      batchNo: 'SOON',
      expiryDate: new Date('2026-10-15T00:00:00Z'),
      createdAt: new Date(3),
    },
    {
      id: 'b-noexp',
      batchNo: 'NOEXP',
      expiryDate: null,
      createdAt: new Date(4),
    },
  ];
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'batchId' && v && typeof v === 'object')
        return r.batchId !== null;
      if (k === 'reversedBy') return !rows.some((x) => x.reversalOfId === r.id);
      if (k === 'reversalOfId' && v === null) return !r.reversalOfId;
      return (r as unknown as Record<string, unknown>)[k] === v;
    });

  const tx = {
    rows,
    locks,
    $executeRaw: vi.fn((_s: TemplateStringsArray, key: string) => {
      locks.push(key);
      return Promise.resolve(1);
    }),
    product: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(products.filter((p) => where.id.in.includes(p.id))),
    },
    godown: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(godowns.filter((g) => where.id.in.includes(g.id))),
    },
    batch: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(batches.filter((b) => where.id.in.includes(b.id))),
    },
    stockMovement: {
      aggregate: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve({
          _sum: {
            quantity: rows
              .filter((r) => matches(r, where))
              .reduce((s, r) => s.plus(r.quantity), D(0)),
          },
        }),
      groupBy: ({ where }: { where: Record<string, unknown> }) => {
        const sums = new Map<string, Prisma.Decimal>();
        for (const r of rows.filter((x) => matches(x, where))) {
          sums.set(r.batchId!, (sums.get(r.batchId!) ?? D(0)).plus(r.quantity));
        }
        return Promise.resolve(
          [...sums].map(([batchId, q]) => ({ batchId, _sum: { quantity: q } })),
        );
      },
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((r) => matches(r, where))),
      createManyAndReturn: ({
        data,
      }: {
        data: Omit<Row, 'id' | 'createdAt'>[];
      }) => {
        const created = data.map((d) => ({
          ...d,
          id: `m${++seq}`,
          createdAt: new Date(seq),
        }));
        rows.push(...created);
        return Promise.resolve(created);
      },
    },
  };
  return tx;
}

type FakeTx = ReturnType<typeof fakeTx>;
const asTx = (tx: FakeTx) => tx as unknown as Prisma.TransactionClient;

function move(over: Partial<MovementInput>): MovementInput {
  return {
    tenantId: T,
    godownId: MAIN,
    productId: 'soap',
    type: MovementType.PURCHASE,
    quantity: D(1),
    refType: 'TEST',
    refId: 'doc-1',
    createdById: USER,
    ...over,
  };
}

describe('StockService', () => {
  let stock: StockService;
  let tx: FakeTx;

  beforeEach(() => {
    stock = new StockService();
    tx = fakeTx();
  });

  const balance = (productId = 'soap', batchId?: string) =>
    stock.getBalance(asTx(tx), T, MAIN, productId, batchId);

  it('posts IN movements and the balance is their sum', async () => {
    await stock.postMovements(asTx(tx), [
      move({ quantity: D(144) }),
      move({ quantity: D(29) }),
    ]);
    expect((await balance()).toString()).toBe('173');
    expect(tx.locks).toEqual([]); // no lock needed for stock coming in
  });

  it('posts an OUT movement after taking an advisory lock', async () => {
    await stock.postMovements(asTx(tx), [move({ quantity: D(173) })]);
    await stock.postMovements(asTx(tx), [
      move({ type: MovementType.SALE, quantity: D(-100), refId: 'inv-1' }),
    ]);
    expect((await balance()).toString()).toBe('73');
    expect(tx.locks).toEqual([`stock:${T}:${MAIN}:soap`]);
  });

  it('blocks negative stock with a breakdown of what is available', async () => {
    await stock.postMovements(asTx(tx), [move({ quantity: D(173) })]);

    const attempt = stock.postMovements(asTx(tx), [
      move({ type: MovementType.SALE, quantity: D(-200) }),
    ]);
    await expect(attempt).rejects.toThrow(InsufficientStockException);
    await expect(attempt).rejects.toThrow(
      'Not enough stock: Lifebuoy Soap in Main Godown, available 1 carton 2 box 5 pcs',
    );
    expect((await balance()).toString()).toBe('173'); // nothing written
  });

  it('checks the net change when a batch has both in and out rows', async () => {
    await stock.postMovements(asTx(tx), [move({ quantity: D(10) })]);
    await stock.postMovements(asTx(tx), [
      move({ type: MovementType.ADJUSTMENT, quantity: D(-15) }),
      move({ type: MovementType.ADJUSTMENT, quantity: D(6) }),
    ]);
    expect((await balance()).toString()).toBe('1');
  });

  it('requires a batch for batch-tracked products', async () => {
    await expect(
      stock.postMovements(asTx(tx), [move({ productId: 'dettol' })]),
    ).rejects.toThrow('A batch is required for Dettol 125ml');
  });

  it('checks batch-tracked stock per batch', async () => {
    await stock.postMovements(asTx(tx), [
      move({ productId: 'dettol', batchId: 'b-soon', quantity: D(10) }),
      move({ productId: 'dettol', batchId: 'b-late', quantity: D(50) }),
    ]);
    await expect(
      stock.postMovements(asTx(tx), [
        move({
          productId: 'dettol',
          batchId: 'b-soon',
          type: MovementType.SALE,
          quantity: D(-11),
        }),
      ]),
    ).rejects.toThrow(
      'Dettol 125ml (batch SOON) in Main Godown, available 10 pcs',
    );
  });

  describe('allocateFEFO', () => {
    const today = new Date('2026-09-25T00:00:00Z');

    beforeEach(async () => {
      await stock.postMovements(asTx(tx), [
        move({ productId: 'dettol', batchId: 'b-expired', quantity: D(100) }),
        move({ productId: 'dettol', batchId: 'b-late', quantity: D(30) }),
        move({ productId: 'dettol', batchId: 'b-soon', quantity: D(20) }),
        move({ productId: 'dettol', batchId: 'b-noexp', quantity: D(40) }),
      ]);
    });

    const allocate = (qty: number) =>
      stock.allocateFEFO(asTx(tx), T, MAIN, 'dettol', D(qty), today);

    it('takes the earliest expiry first, batches without expiry last', async () => {
      const result = await allocate(60);
      expect(result.map((a) => [a.batchId, a.qty.toNumber()])).toEqual([
        ['b-soon', 20],
        ['b-late', 30],
        ['b-noexp', 10],
      ]);
    });

    it('uses only what is needed from the first batch', async () => {
      const result = await allocate(5);
      expect(result.map((a) => [a.batchId, a.qty.toNumber()])).toEqual([
        ['b-soon', 5],
      ]);
    });

    it('skips expired batches even though they have stock', async () => {
      const result = await allocate(90);
      expect(result.map((a) => a.batchId)).not.toContain('b-expired');
      await expect(allocate(91)).rejects.toThrow(
        'Not enough stock: Dettol 125ml in Main Godown, available 7 box 6 pcs (expired batches excluded)',
      );
    });

    it('skips batches that are sold out', async () => {
      await stock.postMovements(asTx(tx), [
        move({
          productId: 'dettol',
          batchId: 'b-soon',
          type: MovementType.SALE,
          quantity: D(-20),
        }),
      ]);
      const result = await allocate(10);
      expect(result.map((a) => a.batchId)).toEqual(['b-late']);
    });
  });

  describe('reverseMovements', () => {
    it('posts opposite rows linked to the originals and never edits them', async () => {
      await stock.postMovements(asTx(tx), [
        move({ quantity: D(144), refType: 'PURCHASE', refId: 'pur-1' }),
        move({ quantity: D(12), refType: 'PURCHASE', refId: 'pur-1' }),
      ]);
      const originals = tx.rows.map((r) => ({ ...r }));

      const reversals = await stock.reverseMovements(
        asTx(tx),
        T,
        'PURCHASE',
        'pur-1',
        USER,
      );

      expect(
        reversals.map((r) => [r.quantity.toNumber(), r.reversalOfId]),
      ).toEqual([
        [-144, originals[0].id],
        [-12, originals[1].id],
      ]);
      expect(tx.rows.slice(0, 2)).toEqual(originals);
      expect((await balance()).toString()).toBe('0');
    });

    it('does nothing the second time (already reversed)', async () => {
      await stock.postMovements(asTx(tx), [
        move({ quantity: D(5), refType: 'PURCHASE', refId: 'pur-1' }),
      ]);
      await stock.reverseMovements(asTx(tx), T, 'PURCHASE', 'pur-1', USER);
      const again = await stock.reverseMovements(
        asTx(tx),
        T,
        'PURCHASE',
        'pur-1',
        USER,
      );
      expect(again).toEqual([]);
      expect(tx.rows).toHaveLength(2);
    });

    it('refuses a reversal that would make stock negative', async () => {
      await stock.postMovements(asTx(tx), [
        move({ quantity: D(10), refType: 'PURCHASE', refId: 'pur-1' }),
      ]);
      await stock.postMovements(asTx(tx), [
        move({
          type: MovementType.SALE,
          quantity: D(-8),
          refType: 'INVOICE',
          refId: 'inv-1',
        }),
      ]);
      await expect(
        stock.reverseMovements(asTx(tx), T, 'PURCHASE', 'pur-1', USER),
      ).rejects.toThrow(
        'Not enough stock: Lifebuoy Soap in Main Godown, available 2 pcs',
      );
      expect(tx.rows).toHaveLength(2);
    });
  });
});
