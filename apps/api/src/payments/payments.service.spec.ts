import type { OutstandingService } from '../accounts/outstanding.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  ChequeStatus,
  LedgerEntryType,
  PartyType,
  PaymentDirection,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import type { LedgerService } from '../ledger/ledger.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PaymentsService } from './payments.service.js';

const D = (v: number | string) => new Prisma.Decimal(v);
const office: AuthUser = {
  userId: 'office-1',
  tenantId: 't1',
  role: UserRole.OFFICE,
};
const salesman: AuthUser = {
  userId: 'sm-1',
  tenantId: 't1',
  role: UserRole.SALESMAN,
};

const unpaid = [
  {
    invoiceId: 'i1',
    invoiceNo: 1,
    fiscalYear: '2083/84',
    invoiceDate: new Date('2026-08-01'),
    total: D(5000),
    outstanding: D(3000),
    creditDays: 15,
  },
  {
    invoiceId: 'i2',
    invoiceNo: 2,
    fiscalYear: '2083/84',
    invoiceDate: new Date('2026-08-15'),
    total: D(4000),
    outstanding: D(4000),
    creditDays: 15,
  },
];

function payment(over: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    tenantId: 't1',
    partyId: 'party-1',
    direction: PaymentDirection.IN,
    fiscalYear: '2083/84',
    receiptNo: 9,
    method: PaymentMethod.CHEQUE,
    amount: D(5000),
    status: PaymentStatus.ACTIVE,
    chequeNo: '000123',
    chequeBank: 'Nabil Bank',
    chequeStatus: ChequeStatus.PENDING,
    collectedById: 'sm-1',
    handover: null,
    allocations: [],
    ...over,
  };
}

function setup(existing = payment()) {
  const tx = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('').includes('doc_sequences') ? [{ last_number: 9 }] : [],
      ),
    ),
    payment: {
      create: vi
        .fn()
        .mockResolvedValue({
          id: 'pay-new',
          paymentDate: new Date('2026-09-25'),
        }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    paymentAllocation: {
      // pay-1 settled i1 (3000) and part of i2 (2000)
      groupBy: vi.fn().mockResolvedValue([
        { invoiceId: 'i1', _sum: { amount: D(3000) } },
        { invoiceId: 'i2', _sum: { amount: D(2000) } },
      ]),
      createMany: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    party: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          id: 'party-1',
          name: 'Kirana',
          type: PartyType.CUSTOMER,
        }),
    },
    payment: {
      findFirst: vi.fn().mockResolvedValue(existing),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    ledgerEntry: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const ledger = { post: vi.fn() };
  const outstanding = { unpaidInvoices: vi.fn().mockResolvedValue(unpaid) };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    { log: vi.fn() } as unknown as AuditService,
    ledger as unknown as LedgerService,
    outstanding as unknown as OutstandingService,
  );
  return { service, prisma, tx, ledger };
}

describe('PaymentsService.receive', () => {
  const dto = { partyId: 'party-1', amount: 8000, method: PaymentMethod.CASH };

  it('auto-allocates FIFO, keeps the rest as advance, and credits the ledger', async () => {
    const { service, tx, ledger } = setup();
    await service.receive(office, dto);

    const data = tx.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      receiptNo: 9,
      direction: 'IN',
      collectedById: 'office-1',
    });
    expect(
      data.allocations.createMany.data.map(
        (a: { invoiceId: string; amount: Prisma.Decimal }) => [
          a.invoiceId,
          a.amount.toNumber(),
        ],
      ),
    ).toEqual([
      ['i1', 3000],
      ['i2', 4000],
    ]); // 1000 left as advance
    expect(ledger.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: LedgerEntryType.PAYMENT,
        credit: D(8000),
        refId: 'pay-new',
      }),
    );
  });

  it('uses the allocations the user chose (partial payment of a newer invoice)', async () => {
    const { service, tx } = setup();
    await service.receive(office, {
      ...dto,
      amount: 1500,
      allocations: [{ invoiceId: 'i2', amount: 1500 }],
    });
    expect(
      tx.payment.create.mock.calls[0][0].data.allocations.createMany.data,
    ).toEqual([{ tenantId: 't1', invoiceId: 'i2', amount: D(1500) }]);
  });

  it('rejects an allocation above the invoice outstanding', async () => {
    const { service, tx } = setup();
    await expect(
      service.receive(office, {
        ...dto,
        allocations: [{ invoiceId: 'i1', amount: 3500 }],
      }),
    ).rejects.toThrow('Bad Request');
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it('requires cheque details for CHEQUE and rejects them otherwise', async () => {
    const { service } = setup();
    await expect(
      service.receive(office, { ...dto, method: PaymentMethod.CHEQUE }),
    ).rejects.toThrow(
      'chequeNo, chequeBank and chequeDate are required for CHEQUE',
    );
    await expect(
      service.receive(office, { ...dto, chequeNo: '1' }),
    ).rejects.toThrow('Cheque details are only allowed when method is CHEQUE');
  });

  it('returns the existing payment for a repeated clientUuid', async () => {
    const { service, prisma, tx } = setup();
    prisma.payment.findUnique.mockResolvedValue(
      payment({ collectedById: 'sm-1' }),
    );
    const result = await service.receive(salesman, {
      ...dto,
      clientUuid: '6f1c7e0b-2f7a-4b54-9a36-6e4f3f1d9a10',
    });
    expect(result).toMatchObject({ id: 'pay-1', idempotentReplay: true });
    expect(tx.payment.create).not.toHaveBeenCalled();
  });
});

describe('PaymentsService cheque bounce and reversal', () => {
  it('a bounced cheque debits the ledger back and releases its allocations', async () => {
    const { service, tx, ledger } = setup();
    await service.chequeBounced(office, 'pay-1', 'Insufficient funds');

    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'ACTIVE', chequeStatus: 'PENDING' },
      data: expect.objectContaining({
        chequeStatus: 'BOUNCED',
        status: 'REVERSED',
        reversalReason: 'Insufficient funds',
      }),
    });
    // Balance goes back up by the cheque amount.
    expect(ledger.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: LedgerEntryType.PAYMENT,
        debit: D(5000),
        refId: 'pay-1',
      }),
    );
    expect(tx.paymentAllocation.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: 't1',
          paymentId: 'pay-1',
          invoiceId: 'i1',
          amount: D(-3000),
        },
        {
          tenantId: 't1',
          paymentId: 'pay-1',
          invoiceId: 'i2',
          amount: D(-2000),
        },
      ],
    });
  });

  it('cannot bounce a cheque that already cleared', async () => {
    const { service, ledger } = setup(
      payment({ chequeStatus: ChequeStatus.CLEARED }),
    );
    await expect(
      service.chequeBounced(office, 'pay-1', 'late'),
    ).rejects.toThrow('The cheque is CLEARED');
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('reversal adds opposite rows and never deletes', async () => {
    const { service, tx, ledger } = setup(
      payment({ method: PaymentMethod.CASH, chequeStatus: null }),
    );
    await service.reverse(office, 'pay-1', 'Entered twice');
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'ACTIVE' },
      data: expect.objectContaining({ status: 'REVERSED' }),
    });
    expect(ledger.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ debit: D(5000) }),
    );
    expect(tx.paymentAllocation.createMany).toHaveBeenCalled();
  });

  it('reversing a supplier payment credits the supplier back', async () => {
    const { service, tx, ledger } = setup(
      payment({
        direction: PaymentDirection.OUT,
        method: PaymentMethod.BANK,
        chequeStatus: null,
      }),
    );
    tx.paymentAllocation.groupBy.mockResolvedValue([]);
    await service.reverse(office, 'pay-1', 'Wrong supplier');
    expect(ledger.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: LedgerEntryType.PURCHASE_PAYMENT,
        credit: D(5000),
      }),
    );
  });

  it('refuses to reverse cash that sits in a submitted handover', async () => {
    const { service } = setup(
      payment({
        method: PaymentMethod.CASH,
        handover: {
          id: 'h1',
          handoverNo: 'HO-2083/84-00001',
          status: 'SUBMITTED',
        },
      }),
    );
    await expect(service.reverse(office, 'pay-1', 'x y z')).rejects.toThrow(
      /verify or dispute it first/,
    );
  });
});
