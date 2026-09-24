import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { pageArgs, type PaginationQueryDto } from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreatePriceTierDto,
  ProductPriceItemDto,
  UpdatePriceTierDto,
} from './dto/pricing.dto.js';
import { pickPrice, type PriceSource } from './price-resolution.js';

type Decimal = Prisma.Decimal;

/** Audit entity used for product price changes; its rows are the price history. */
export const PRICE_AUDIT_ENTITY = 'ProductPrice';

/** One validated price to write. Names are kept for readable price history. */
export interface PriceRow {
  unitId: string;
  unitName: string;
  priceTierId: string;
  tierName: string;
  price: Decimal;
}

export interface ResolvedItem {
  productId: string;
  unitId: string;
  unitName: string | null;
  price: string | null;
  source: PriceSource | null;
  error?: string;
}

const NO_PRICE = 'No price set';
const DUPLICATE_TIER = 'A price tier with this name already exists';

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── Tiers ─────────────────────────────────────────────────────────────────

  listTiers(actor: AuthUser, includeInactive = false) {
    return this.prisma.priceTier.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: { name: 'asc' },
    });
  }

  async createTier(actor: AuthUser, dto: CreatePriceTierDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tier = await tx.priceTier.create({
          data: { tenantId: actor.tenantId, name: dto.name },
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'PriceTier',
            entityId: tier.id,
            action: AuditAction.CREATE,
            newValue: tier,
          },
          tx,
        );
        return tier;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE_TIER);
      throw e;
    }
  }

  async updateTier(actor: AuthUser, id: string, dto: UpdatePriceTierDto) {
    const before = await this.prisma.priceTier.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!before) throw new NotFoundException('Price tier not found');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tier = await tx.priceTier.update({
          where: { id },
          data: { name: dto.name, isActive: dto.isActive },
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'PriceTier',
            entityId: id,
            action: AuditAction.UPDATE,
            oldValue: before,
            newValue: tier,
          },
          tx,
        );
        return tier;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE_TIER);
      throw e;
    }
  }

  // ─── Product prices ────────────────────────────────────────────────────────

  async getProductPrices(tenantId: string, productId: string) {
    const prices = await this.prisma.productPrice.findMany({
      where: { tenantId, productId },
      include: { unit: true, priceTier: true },
      orderBy: [{ unit: { factor: 'asc' } }, { priceTier: { name: 'asc' } }],
    });
    return prices.map((p) => ({
      unitId: p.unitId,
      unitName: p.unit.name,
      priceTierId: p.priceTierId,
      tierName: p.priceTier.name,
      price: p.price.toFixed(2),
    }));
  }

  /** PUT /products/:id/prices: validates every item, then upserts all in one transaction. */
  async setProductPrices(
    actor: AuthUser,
    productId: string,
    items: ProductPriceItemDto[],
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: actor.tenantId },
      include: { units: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const tiers = await this.prisma.priceTier.findMany({
      where: { tenantId: actor.tenantId },
    });

    const unitById = new Map(product.units.map((u) => [u.id, u]));
    const tierById = new Map(tiers.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const errors: string[] = [];
    const rows: PriceRow[] = [];

    items.forEach((item, i) => {
      const unit = unitById.get(item.unitId);
      const tier = tierById.get(item.priceTierId);
      if (!unit) errors.push(`[${i}] unitId is not a unit of this product`);
      if (!tier) errors.push(`[${i}] priceTierId not found`);
      const key = `${item.unitId}:${item.priceTierId}`;
      if (seen.has(key)) {
        errors.push(`[${i}] duplicate unit + tier in the list`);
      }
      seen.add(key);
      if (unit && tier) {
        rows.push({
          unitId: unit.id,
          unitName: unit.name,
          priceTierId: tier.id,
          tierName: tier.name,
          price: new Prisma.Decimal(item.price),
        });
      }
    });
    if (errors.length) throw new BadRequestException(errors);

    await this.prisma.$transaction((tx) =>
      this.writePrices(tx, actor, productId, rows),
    );
    return this.getProductPrices(actor.tenantId, productId);
  }

  /**
   * Upserts already-validated prices inside the caller's transaction. Unchanged
   * prices are skipped; every real change writes an audit row with the old and
   * new price, which is the product's price history. Returns how many changed.
   */
  async writePrices(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    productId: string,
    rows: PriceRow[],
  ) {
    const existing = await tx.productPrice.findMany({ where: { productId } });
    const byKey = new Map(
      existing.map((p) => [`${p.unitId}:${p.priceTierId}`, p]),
    );
    let changed = 0;

    for (const row of rows) {
      const old = byKey.get(`${row.unitId}:${row.priceTierId}`);
      if (old?.price.equals(row.price)) continue;

      await tx.productPrice.upsert({
        where: {
          productId_unitId_priceTierId: {
            productId,
            unitId: row.unitId,
            priceTierId: row.priceTierId,
          },
        },
        create: {
          tenantId: actor.tenantId,
          productId,
          unitId: row.unitId,
          priceTierId: row.priceTierId,
          price: row.price,
        },
        update: { price: row.price },
      });
      const label = {
        unitId: row.unitId,
        unitName: row.unitName,
        priceTierId: row.priceTierId,
        tierName: row.tierName,
      };
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: PRICE_AUDIT_ENTITY,
          entityId: productId,
          action: old ? AuditAction.UPDATE : AuditAction.CREATE,
          oldValue: old ? { ...label, price: old.price.toFixed(2) } : undefined,
          newValue: { ...label, price: row.price.toFixed(2) },
        },
        tx,
      );
      changed++;
    }
    return changed;
  }

  async priceHistory(
    actor: AuthUser,
    productId: string,
    query: PaginationQueryDto,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const where = {
      tenantId: actor.tenantId,
      entity: PRICE_AUDIT_ENTITY,
      entityId: productId,
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(query),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        changedAt: r.createdAt,
        changedBy: r.user,
        action: r.action,
        oldValue: r.oldValue,
        newValue: r.newValue,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  // ─── Resolution ────────────────────────────────────────────────────────────

  /** GET /pricing/resolve: a single price, or a 404 / 422 error. */
  async resolve(
    actor: AuthUser,
    partyId: string,
    productId: string,
    unitId: string,
  ) {
    const [item] = await this.resolveMany(actor, partyId, [
      { productId, unitId },
    ]);
    if (item.error === NO_PRICE) {
      throw new UnprocessableEntityException(NO_PRICE);
    }
    if (item.error) throw new NotFoundException(item.error);
    return { price: item.price, source: item.source, unitName: item.unitName };
  }

  /**
   * Resolves many items for one party with a fixed number of queries.
   * Items that can't be priced carry an `error` instead of failing the batch.
   */
  async resolveMany(
    actor: AuthUser,
    partyId: string,
    items: { productId: string; unitId: string }[],
  ): Promise<ResolvedItem[]> {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId: actor.tenantId },
      include: { priceTier: true },
    });
    if (!party) throw new NotFoundException('Party not found');
    // A deactivated tier no longer supplies prices.
    const tierId = party.priceTier?.isActive ? party.priceTierId : null;

    const productIds = [...new Set(items.map((i) => i.productId))];
    const [products, specials, tierPrices] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds }, tenantId: actor.tenantId },
        include: { units: true },
      }),
      this.prisma.partyPrice.findMany({
        where: { partyId, productId: { in: productIds } },
      }),
      tierId
        ? this.prisma.productPrice.findMany({
            where: { priceTierId: tierId, productId: { in: productIds } },
          })
        : Promise.resolve([]),
    ]);

    const productById = new Map(products.map((p) => [p.id, p]));
    const specialByKey = new Map(
      specials.map((s) => [`${s.productId}:${s.unitId}`, s.price]),
    );
    const tierByKey = new Map(
      tierPrices.map((t) => [`${t.productId}:${t.unitId}`, t.price]),
    );

    return items.map(({ productId, unitId }) => {
      const empty = { productId, unitId, price: null, source: null };
      const product = productById.get(productId);
      if (!product) {
        return { ...empty, unitName: null, error: 'Product not found' };
      }
      const unit = product.units.find((u) => u.id === unitId);
      if (!unit) {
        return {
          ...empty,
          unitName: null,
          error: 'Unit not found for this product',
        };
      }
      const baseUnit = product.units.find((u) => u.factor.equals(1));
      const picked = pickPrice({
        special: specialByKey.get(`${productId}:${unitId}`),
        tierPrice: tierByKey.get(`${productId}:${unitId}`),
        baseTierPrice: baseUnit
          ? tierByKey.get(`${productId}:${baseUnit.id}`)
          : null,
        unitFactor: unit.factor,
      });
      if (!picked) return { ...empty, unitName: unit.name, error: NO_PRICE };
      return {
        productId,
        unitId,
        unitName: unit.name,
        price: picked.price.toFixed(2),
        source: picked.source,
      };
    });
  }
}
