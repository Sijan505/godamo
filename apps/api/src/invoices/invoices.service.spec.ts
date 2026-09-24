import type { OutstandingService } from '../accounts/outstanding.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { calculateBill } from '../common/billing/bill-totals.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { evaluateCredit } from '../credit/credit-rules.js';
import {
  CreditBlockedException,
  type CreditService,
} from '../credit/credit.service.js';
import {
  InvoiceStatus,
  LedgerEntryType,
  MovementType,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import type { GodownsService } from '../godowns/godowns.service.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SaleLinesService } from '../sales/sale-lines.service.js';
import type { StockService } from '../stock/stock.service.js';
import { InvoicesService } from './invoices.service.js';

const D = (v: number | string) => new Prisma.Decimal(v);
const actor: AuthUser = {
  userId: 'office-1',
  tenantId: 't1',
  role: UserRole.OFFICE,
};
const party = {
  id: 'party-1',
  name: 'Shrestha Kirana Pasal',
  creditLimit: D(50000),
};

// 2 box of batch-tracked Dettol (24 pcs) + 10 pcs of Coke (not tracked).
const dettol = {
  id: 'dettol',
  name: 'Dettol',
  trackBatch: true,
  vatApplicable: true,
  units: [],
};
const coke = {
  id: 'coke',
  name: 'Coke',
  trackBatch: false,
  vatApplicable: true,
  units: [],
};
const saleLines = [
  {
    lineNo: 1,
    product: dettol,
    unitId: 'box',
    factor: D(12),
    quantity: D(2),
    baseQty: D(24),
    rate: D(1380),
    priceSource: 'TIER',
    discountPercent: D(0),
    discount: D(0),
  },
  {
    lineNo: 2,
    product: coke,
    unitId: 'pcs',
    factor: D(1),
    quantity: D(10),
    baseQty: D(10),
    rate: D(50),
    priceSource: 'SPECIAL',
    discountPercent: D(0),
    discount: D(0),
  },
];
const totals = calculateBill(
  saleLines.map((l) => ({
    quantity: l.quantity,
    rate: l.rate,
    discount: l.discount,
    vatApplicable: true,
  })),
  D(0),
); // 2760 + 500 = 3260; VAT 423.80; total 3683.80

function setup(balance: number) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    invoice: {
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    salesOrder: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    paymentAllocation: {
      // A Rs 1000 receipt was applied to the invoice before it was cancelled.
      groupBy: vi
        .fn()
        .mockResolvedValue([{ paymentId: 'pay-1', _sum: { amount: D(1000) } }]),
      createMany: vi.fn(),
    },
  };
  tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join('').includes('doc_sequences') ? [{ last_number: 7 }] : [],
    ),
  );
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    invoice: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'inv-1',
        partyId: party.id,
        orderId: null,
        invoiceNo: 7,
        fiscalYear: '2083/84',
        total: totals.total,
        status: InvoiceStatus.ISSUED,
      }),
    },
  };
  const stock = {
    averageCosts: vi.fn().mockResolvedValue(
      new Map([
        ['dettol', D(96)],
        ['coke', D(42)],
      ]),
    ),
    allocateFEFO: vi.fn().mockResolvedValue([
      { batchId: 'DT-A', qty: D(7) },
      { batchId: 'DT-B', qty: D(17) },
    ]),
    postMovements: vi.fn(),
    reverseMovements: vi.fn(),
  };
  const credit = {
    checkCredit: vi.fn(() =>
      Promise.resolve(
        evaluateCredit(D(balance), party.creditLimit, totals.total),
      ),
    ),
    assertApprovalUsable: vi.fn(),
    markApprovalUsed: vi.fn(),
  };
  const ledger = { post: vi.fn() };
  const service = new InvoicesService(
    prisma as unknown as PrismaService,
    { log: vi.fn() } as unknown as AuditService,
    {
      getCustomer: vi.fn().mockResolvedValue(party),
      price: vi.fn().mockResolvedValue({ lines: saleLines, totals }),
    } as unknown as SaleLinesService,
    stock as unknown as StockService,
    ledger as unknown as LedgerService,
    credit as unknown as CreditService,
    {
      getActive: vi.fn().mockResolvedValue({ id: 'main' }),
    } as unknown as GodownsService,
    {
      paymentInfo: vi.fn().mockResolvedValue(new Map()),
    } as unknown as OutstandingService,
  );
  return { service, tx, stock, credit, ledger };
}

const dto = {
  partyId: party.id,
  godownId: 'main',
  items: [
    { productId: 'dettol', unitId: 'box', quantity: 2 },
    { productId: 'coke', unitId: 'pcs', quantity: 10 },
  ],
};

describe('InvoicesService.create', () => {
  it('issues an invoice: FEFO batches become separate lines, SALE movements, DEBIT ledger', async () => {
    const { service, tx, stock, ledger } = setup(10000);
    await service.create(actor, dto);

    // Batch-tracked product -> FEFO; the other one is not.
    expect(stock.allocateFEFO).toHaveBeenCalledTimes(1);
    expect(stock.allocateFEFO).toHaveBeenCalledWith(
      tx,
      't1',
      'main',
      'dettol',
      D(24),
    );
    const moves = stock.postMovements.mock.calls.flatMap((c) => c[1]);
    expect(
      moves.map((m) => [m.productId, m.batchId, m.quantity.toNumber(), m.type]),
    ).toEqual([
      ['dettol', 'DT-A', -7, MovementType.SALE],
      ['dettol', 'DT-B', -17, MovementType.SALE],
      ['coke', null, -10, MovementType.SALE],
    ]);

    const data = tx.invoice.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      invoiceNo: 7,
      fiscalYear: expect.stringMatching(/^\d{4}\/\d{2}$/),
    });
    expect(data.total.toFixed(2)).toBe('3683.80');
    const rows = data.items.createMany.data;
    expect(
      rows.map(
        (r: {
          lineNo: number;
          batchId: string | null;
          baseQuantity: Prisma.Decimal;
        }) => [r.lineNo, r.batchId, r.baseQuantity.toNumber()],
      ),
    ).toEqual([
      [1, 'DT-A', 7],
      [1, 'DT-B', 17],
      [2, null, 10],
    ]);
    const lineOneAmount = rows
      .filter((r: { lineNo: number }) => r.lineNo === 1)
      .reduce(
        (s: Prisma.Decimal, r: { amount: Prisma.Decimal }) => s.plus(r.amount),
        D(0),
      );
    expect(lineOneAmount.toFixed(2)).toBe('2760.00');

    expect(ledger.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: LedgerEntryType.INVOICE,
        debit: totals.total,
        partyId: party.id,
      }),
    );
  });

  it('blocks a party over its credit limit with numbers for the UI', async () => {
    const { service, stock, tx } = setup(48000); // 48000 + 3683.80 > 50000
    const attempt = service.create(actor, dto);
    await expect(attempt).rejects.toThrow(CreditBlockedException);
    await attempt.catch((e: CreditBlockedException) =>
      expect(e.getResponse()).toMatchObject({
        code: 'CREDIT_LIMIT_EXCEEDED',
        balance: '48000.00',
        creditLimit: '50000.00',
        invoiceTotal: '3683.80',
      }),
    );
    expect(stock.postMovements).not.toHaveBeenCalled();
    expect(tx.invoice.create).not.toHaveBeenCalled();
  });

  it('bills over the limit with an approval: checked before stock, marked used after', async () => {
    const { service, credit, stock, tx } = setup(48000);
    await service.create(actor, { ...dto, creditApprovalId: 'appr-1' });
    expect(credit.assertApprovalUsable).toHaveBeenCalledWith(
      tx,
      actor,
      'appr-1',
      {
        partyId: party.id,
        total: totals.total,
      },
    );
    expect(
      credit.assertApprovalUsable.mock.invocationCallOrder[0],
    ).toBeLessThan(stock.postMovements.mock.invocationCallOrder[0]);
    const invoiceId = tx.invoice.create.mock.calls[0][0].data.id;
    expect(credit.markApprovalUsed).toHaveBeenCalledWith(
      tx,
      'appr-1',
      invoiceId,
    );
  });

  it('stops before touching stock when the approval is not usable', async () => {
    const { service, credit, stock } = setup(48000);
    credit.assertApprovalUsable.mockRejectedValue(
      new Error('The credit approval is still pending'),
    );
    await expect(
      service.create(actor, { ...dto, creditApprovalId: 'appr-1' }),
    ).rejects.toThrow('still pending');
    expect(stock.postMovements).not.toHaveBeenCalled();
  });

  it('does not use up an approval that is not needed', async () => {
    const { service, credit } = setup(0);
    await service.create(actor, { ...dto, creditApprovalId: 'appr-1' });
    expect(credit.assertApprovalUsable).not.toHaveBeenCalled();
    expect(credit.markApprovalUsed).not.toHaveBeenCalled();
  });
});

describe('InvoicesService.cancel', () => {
  it('keeps the invoice, reverses its stock and posts an opposite CREDIT entry', async () => {
    const { service, tx, stock, ledger } = setup(0);
    await service.cancel(actor, 'inv-1', 'Wrong party');

    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', tenantId: 't1', status: InvoiceStatus.ISSUED },
      data: expect.objectContaining({
        status: InvoiceStatus.CANCELLED,
        cancelReason: 'Wrong party',
      }),
    });
    expect(stock.reverseMovements).toHaveBeenCalledWith(
      tx,
      't1',
      'INVOICE',
      'inv-1',
      'office-1',
    );
    // The payment applied to it is released as advance (a negative row).
    expect(tx.paymentAllocation.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: 't1',
          paymentId: 'pay-1',
          invoiceId: 'inv-1',
          amount: D(-1000),
        },
      ],
    });
    expect(ledger.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: LedgerEntryType.INVOICE,
        credit: totals.total,
      }),
    );
  });
});
