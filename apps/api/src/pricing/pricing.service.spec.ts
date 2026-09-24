import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { Prisma, UserRole } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { pickPrice } from './price-resolution.js';
import { PricingService } from './pricing.service.js';

const D = (v: number | string) => new Prisma.Decimal(v);

const actor: AuthUser = {
  userId: 'u1',
  tenantId: 't1',
  role: UserRole.SALESMAN,
};

// Lifebuoy: pcs (base) = 1, box = 12, carton = 144
const product = {
  id: 'p1',
  tenantId: 't1',
  units: [
    { id: 'pcs', name: 'pcs', factor: D(1) },
    { id: 'box', name: 'box', factor: D(12) },
    { id: 'carton', name: 'carton', factor: D(144) },
  ],
};
const retailerTier = { id: 'tier-r', name: 'Retailer', isActive: true };
const party = {
  id: 'party1',
  tenantId: 't1',
  priceTierId: retailerTier.id,
  priceTier: retailerTier,
};

describe('pickPrice (resolution order)', () => {
  const factor = D(12);

  it('1) prefers the party special price', () => {
    expect(
      pickPrice({
        special: D(600),
        tierPrice: D(650),
        baseTierPrice: D(55),
        unitFactor: factor,
      }),
    ).toEqual({ price: D(600), source: 'SPECIAL' });
  });

  it('2) then the tier price for that unit', () => {
    expect(
      pickPrice({
        tierPrice: D(650),
        baseTierPrice: D(55),
        unitFactor: factor,
      }),
    ).toEqual({ price: D(650), source: 'TIER' });
  });

  it('3) then base-unit tier price × factor, rounded to paisa', () => {
    const result = pickPrice({ baseTierPrice: D('53.335'), unitFactor: D(3) });
    expect(result?.source).toBe('DERIVED');
    expect(result?.price.toFixed(2)).toBe('160.01'); // 160.005 rounds half up
  });

  it('4) otherwise null', () => {
    expect(pickPrice({ unitFactor: factor })).toBeNull();
    expect(
      pickPrice({
        special: null,
        tierPrice: null,
        baseTierPrice: null,
        unitFactor: factor,
      }),
    ).toBeNull();
  });
});

describe('PricingService.resolve / resolveMany', () => {
  let prisma: {
    party: { findFirst: ReturnType<typeof vi.fn> };
    product: { findMany: ReturnType<typeof vi.fn> };
    partyPrice: { findMany: ReturnType<typeof vi.fn> };
    productPrice: { findMany: ReturnType<typeof vi.fn> };
  };
  let service: PricingService;

  beforeEach(() => {
    prisma = {
      party: { findFirst: vi.fn().mockResolvedValue(party) },
      product: { findMany: vi.fn().mockResolvedValue([product]) },
      partyPrice: { findMany: vi.fn().mockResolvedValue([]) },
      productPrice: { findMany: vi.fn().mockResolvedValue([]) },
    };
    service = new PricingService(
      prisma as unknown as PrismaService,
      { log: vi.fn() } as unknown as AuditService,
    );
  });

  it('returns SPECIAL when the party has a special price for the unit', async () => {
    prisma.partyPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'box', price: D(600) },
    ]);
    prisma.productPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'box', price: D('653.4') },
    ]);

    await expect(
      service.resolve(actor, 'party1', 'p1', 'box'),
    ).resolves.toEqual({
      price: '600.00',
      source: 'SPECIAL',
      unitName: 'box',
    });
  });

  it("returns TIER from the party's tier price for that unit", async () => {
    prisma.productPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'box', price: D('653.4') },
      { productId: 'p1', unitId: 'pcs', price: D(55) },
    ]);

    await expect(
      service.resolve(actor, 'party1', 'p1', 'box'),
    ).resolves.toEqual({
      price: '653.40',
      source: 'TIER',
      unitName: 'box',
    });
    expect(prisma.productPrice.findMany).toHaveBeenCalledWith({
      where: { priceTierId: 'tier-r', productId: { in: ['p1'] } },
    });
  });

  it('returns DERIVED from the base-unit tier price × factor', async () => {
    prisma.productPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'pcs', price: D(55) },
    ]);

    await expect(
      service.resolve(actor, 'party1', 'p1', 'carton'),
    ).resolves.toEqual({
      price: '7920.00',
      source: 'DERIVED',
      unitName: 'carton',
    });
  });

  it('throws 422 "No price set" when nothing applies', async () => {
    await expect(service.resolve(actor, 'party1', 'p1', 'box')).rejects.toThrow(
      new UnprocessableEntityException('No price set'),
    );
  });

  it('uses only special prices for a party without a tier', async () => {
    prisma.party.findFirst.mockResolvedValue({
      ...party,
      priceTierId: null,
      priceTier: null,
    });
    prisma.partyPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'pcs', price: D(50) },
    ]);

    const [pcs, box] = await service.resolveMany(actor, 'party1', [
      { productId: 'p1', unitId: 'pcs' },
      { productId: 'p1', unitId: 'box' },
    ]);
    expect(pcs).toMatchObject({ price: '50.00', source: 'SPECIAL' });
    expect(box).toMatchObject({ price: null, error: 'No price set' });
    expect(prisma.productPrice.findMany).not.toHaveBeenCalled();
  });

  it('ignores a deactivated tier', async () => {
    prisma.party.findFirst.mockResolvedValue({
      ...party,
      priceTier: { ...retailerTier, isActive: false },
    });
    prisma.productPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'box', price: D(650) },
    ]);

    await expect(service.resolve(actor, 'party1', 'p1', 'box')).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(prisma.productPrice.findMany).not.toHaveBeenCalled();
  });

  it('404s for an unknown party, product or unit', async () => {
    prisma.party.findFirst.mockResolvedValueOnce(null);
    await expect(service.resolve(actor, 'nope', 'p1', 'box')).rejects.toThrow(
      new NotFoundException('Party not found'),
    );

    prisma.product.findMany.mockResolvedValueOnce([]);
    await expect(
      service.resolve(actor, 'party1', 'other', 'box'),
    ).rejects.toThrow(new NotFoundException('Product not found'));

    await expect(
      service.resolve(actor, 'party1', 'p1', 'crate'),
    ).rejects.toThrow(new NotFoundException('Unit not found for this product'));
  });

  it('looks the party up inside the caller tenant only', async () => {
    prisma.productPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'pcs', price: D(55) },
    ]);
    await service.resolve(actor, 'party1', 'p1', 'pcs');
    expect(prisma.party.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'party1', tenantId: 't1' } }),
    );
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['p1'] }, tenantId: 't1' },
      }),
    );
  });

  it('bulk: resolves every item with one set of queries and reports per-item errors', async () => {
    prisma.partyPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'carton', price: D(7000) },
    ]);
    prisma.productPrice.findMany.mockResolvedValue([
      { productId: 'p1', unitId: 'pcs', price: D(55) },
      { productId: 'p1', unitId: 'box', price: D('653.4') },
    ]);

    const result = await service.resolveMany(actor, 'party1', [
      { productId: 'p1', unitId: 'carton' },
      { productId: 'p1', unitId: 'box' },
      { productId: 'p1', unitId: 'pcs' },
      { productId: 'missing', unitId: 'pcs' },
    ]);

    expect(result.map((r) => [r.unitId, r.price, r.source ?? r.error])).toEqual(
      [
        ['carton', '7000.00', 'SPECIAL'],
        ['box', '653.40', 'TIER'],
        ['pcs', '55.00', 'TIER'],
        ['pcs', null, 'Product not found'],
      ],
    );
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productPrice.findMany).toHaveBeenCalledTimes(1);
  });
});
