import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  HandoverStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HandoversService } from './handovers.service.js';

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

function setup() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ last_number: 3 }]),
    cashHandover: {
      create: vi
        .fn()
        .mockResolvedValue({ id: 'h1', handoverNo: 'HO-2083/84-00003' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    payment: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    payment: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'p1', amount: D(10000) },
        { id: 'p2', amount: D(5000) },
      ]),
    },
    cashHandover: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'h1',
        status: HandoverStatus.SUBMITTED,
        fromUserId: 'sm-1',
        expectedAmount: D(15000),
      }),
    },
  };
  const audit = { log: vi.fn() };
  const service = new HandoversService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, tx, prisma, audit };
}

describe('HandoversService', () => {
  it('submits my pending cash with expectedAmount = their sum', async () => {
    const { service, tx } = setup();
    await service.submit(salesman, ['p1', 'p2']);
    expect(tx.cashHandover.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromUserId: 'sm-1',
        expectedAmount: D(15000),
      }),
    });
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { handoverId: 'h1' } }),
    );
  });

  it('refuses payments that are not my pending cash', async () => {
    const { service, prisma } = setup();
    prisma.payment.findMany.mockResolvedValue([{ id: 'p1', amount: D(10000) }]);
    await expect(
      service.submit(salesman, ['p1', 'someone-elses']),
    ).rejects.toThrow(/must be your own CASH receipt/);
  });

  it('marks a short count DISPUTED with the difference and audits it', async () => {
    const { service, tx, audit } = setup();
    await service.verify(office, 'h1', 14500, 'Rs 500 short');
    expect(tx.cashHandover.updateMany).toHaveBeenCalledWith({
      where: { id: 'h1', status: HandoverStatus.SUBMITTED },
      data: expect.objectContaining({
        status: HandoverStatus.DISPUTED,
        receivedAmount: D(14500),
        difference: D(-500),
        receivedById: 'office-1',
      }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'CashHandover',
        newValue: expect.objectContaining({ status: 'DISPUTED' }),
      }),
      tx,
    );
  });

  it('marks an exact count VERIFIED', async () => {
    const { service, tx } = setup();
    await service.verify(office, 'h1', 15000);
    expect(tx.cashHandover.updateMany.mock.calls[0][0].data.status).toBe(
      HandoverStatus.VERIFIED,
    );
  });

  it('does not let the collector verify their own handover', async () => {
    const { service } = setup();
    await expect(
      service.verify({ ...office, userId: 'sm-1' }, 'h1', 15000),
    ).rejects.toThrow('You cannot verify your own handover');
  });
});
