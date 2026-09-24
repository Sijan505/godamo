import { ConflictException } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { UserRole } from '../generated/prisma/client.js';
import type { GodownsService } from '../godowns/godowns.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SaleLinesService } from '../sales/sale-lines.service.js';
import type { StockService } from '../stock/stock.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

const salesman: AuthUser = {
  userId: 'sm-1',
  tenantId: 't1',
  role: UserRole.SALESMAN,
};
const CLIENT_UUID = '0b6f1c7e-2f7a-4b54-9a36-6e4f3f1d9a10';

function setup(existing: object | null) {
  const prisma = {
    salesOrder: { findUnique: vi.fn().mockResolvedValue(existing) },
    $transaction: vi.fn(),
  };
  const lines = { getCustomer: vi.fn(), price: vi.fn() };
  const service = new SalesOrdersService(
    prisma as unknown as PrismaService,
    { log: vi.fn() } as unknown as AuditService,
    lines as unknown as SaleLinesService,
    {} as StockService,
    { getActive: vi.fn() } as unknown as GodownsService,
  );
  return { service, prisma, lines };
}

const dto = {
  partyId: 'party-1',
  godownId: 'main',
  clientUuid: CLIENT_UUID,
  items: [{ productId: 'soap', unitId: 'box', quantity: 1 }],
};

describe('SalesOrdersService.create with clientUuid (offline retries)', () => {
  it('returns the existing order instead of creating a second one', async () => {
    const existing = {
      id: 'order-1',
      orderNo: 'SO-2083/84-00001',
      tenantId: 't1',
      salesmanId: 'sm-1',
    };
    const { service, prisma, lines } = setup(existing);

    const result = await service.create(salesman, dto);

    expect(result).toMatchObject({ id: 'order-1', idempotentReplay: true });
    expect(prisma.salesOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientUuid: CLIENT_UUID } }),
    );
    expect(lines.price).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a clientUuid that belongs to another tenant's or salesman's order", async () => {
    await expect(
      setup({
        id: 'x',
        tenantId: 'other-tenant',
        salesmanId: 'sm-1',
      }).service.create(salesman, dto),
    ).rejects.toThrow(ConflictException);
    await expect(
      setup({ id: 'x', tenantId: 't1', salesmanId: 'sm-2' }).service.create(
        salesman,
        dto,
      ),
    ).rejects.toThrow(ConflictException);
  });
});
