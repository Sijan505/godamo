import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthUser } from '../common/types/auth-user.js';
import { Prisma, UserRole } from '../generated/prisma/client.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SaleLinesService } from './sale-lines.service.js';

const D = (v: number | string) => new Prisma.Decimal(v);
const office: AuthUser = {
  userId: 'u1',
  tenantId: 't1',
  role: UserRole.OFFICE,
};
const salesman: AuthUser = { ...office, role: UserRole.SALESMAN };

const units = (box: number) => [
  { id: 'pcs', name: 'pcs', factor: D(1) },
  { id: 'box', name: 'box', factor: D(box) },
];
const PRODUCTS = [
  {
    id: 'soap',
    tenantId: 't1',
    name: 'Soap',
    isActive: true,
    vatApplicable: true,
    baseUnit: 'pcs',
    units: units(12),
  },
  // Rice is VAT-exempt in Nepal.
  {
    id: 'rice',
    tenantId: 't1',
    name: 'Rice 25kg',
    isActive: true,
    vatApplicable: false,
    baseUnit: 'pcs',
    units: units(1),
  },
];

function setup(prices: Record<string, string | null>) {
  const prisma = {
    product: {
      findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(PRODUCTS.filter((p) => where.id.in.includes(p.id))),
      ),
    },
  };
  const pricing = {
    resolveMany: vi.fn(
      (
        _a: AuthUser,
        _p: string,
        items: { productId: string; unitId: string }[],
      ) =>
        Promise.resolve(
          items.map((i) => {
            const price = prices[`${i.productId}:${i.unitId}`];
            return price
              ? { ...i, unitName: i.unitId, price, source: 'TIER' }
              : {
                  ...i,
                  unitName: i.unitId,
                  price: null,
                  source: null,
                  error: 'No price set',
                };
          }),
        ),
    ),
  };
  return {
    service: new SaleLinesService(
      prisma as unknown as PrismaService,
      pricing as unknown as PricingService,
    ),
    pricing,
  };
}

describe('SaleLinesService.price (server-side totals)', () => {
  it('prices from PricingService and charges VAT only on VAT-applicable items', async () => {
    const { service } = setup({ 'soap:box': '653.40', 'rice:pcs': '2100.00' });
    const { lines, totals } = await service.price(office, 'party', [
      { productId: 'soap', unitId: 'box', quantity: 10, discountPercent: 2.5 },
      { productId: 'rice', unitId: 'pcs', quantity: 3 },
    ]);

    expect(
      lines.map((l) => [
        l.rate.toFixed(2),
        l.discount.toFixed(2),
        l.baseQty.toString(),
      ]),
    ).toEqual([
      ['653.40', '163.35', '120'], // 6534 × 2.5% = 163.35; 10 box = 120 pcs
      ['2100.00', '0.00', '3'],
    ]);
    expect(totals.subtotal.toFixed(2)).toBe('12670.65'); // 6370.65 + 6300
    expect(totals.taxableAmount.toFixed(2)).toBe('6370.65');
    expect(totals.exemptAmount.toFixed(2)).toBe('6300.00');
    expect(totals.vatAmount.toFixed(2)).toBe('828.18'); // 13% of 6370.65 = 828.1845
    expect(totals.total.toFixed(2)).toBe('13498.83');
  });

  it('spreads a bill discount before VAT', async () => {
    const { service } = setup({ 'soap:pcs': '100.00' });
    const { totals } = await service.price(
      office,
      'party',
      [{ productId: 'soap', unitId: 'pcs', quantity: 10 }],
      D(100),
    );
    expect(totals.taxableAmount.toFixed(2)).toBe('900.00');
    expect(totals.vatAmount.toFixed(2)).toBe('117.00');
    expect(totals.total.toFixed(2)).toBe('1017.00');
  });

  it('limits a salesman to 5% discount per line but not office staff', async () => {
    const { service } = setup({ 'soap:box': '653.40' });
    const item = {
      productId: 'soap',
      unitId: 'box',
      quantity: 1,
      discountPercent: 5.01,
    };
    await expect(service.price(salesman, 'party', [item])).rejects.toThrow(
      new BadRequestException(
        'Item 1: salesmen can give at most 5% discount per line',
      ),
    );
    await expect(
      service.price(salesman, 'party', [{ ...item, discountPercent: 5 }]),
    ).resolves.toBeDefined();
    await expect(service.price(office, 'party', [item])).resolves.toBeDefined();
  });

  it('refuses items without a price, listing them', async () => {
    const { service } = setup({ 'soap:box': '653.40' });
    const attempt = service.price(office, 'party', [
      { productId: 'soap', unitId: 'box', quantity: 1 },
      { productId: 'rice', unitId: 'pcs', quantity: 1 },
    ]);
    await expect(attempt).rejects.toThrow(UnprocessableEntityException);
    await attempt.catch((e: UnprocessableEntityException) => {
      expect(e.getResponse()).toMatchObject({
        code: 'NO_PRICE',
        items: [{ item: 2, productId: 'rice', error: 'No price set' }],
      });
    });
  });

  it('never accepts a unit from another product', async () => {
    const { service } = setup({});
    await expect(
      service.price(office, 'party', [
        { productId: 'rice', unitId: 'crate', quantity: 1 },
      ]),
    ).rejects.toThrow(BadRequestException);
  });
});
