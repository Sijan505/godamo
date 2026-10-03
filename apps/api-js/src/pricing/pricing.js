import { auditLog } from '../common/audit.js';
import { PaginationQueryDto, pageArgs } from '../common/pagination.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import { AuditAction, Decimal, isUniqueViolation, prisma } from '../db.js';
import { BadRequest, Conflict, NotFound, UnprocessableEntity } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  arrayMaxSize,
  arrayMinSize,
  isArray,
  isBoolean,
  isNumber,
  isPositive,
  isString,
  isUuid,
  length,
  max,
  nested,
  optional,
  queryBoolean,
  schema,
  trim,
} from '../http/validation.js';

export const MAX_MONEY = 999_999_999_999.99;

// ─── Request bodies ─────────────────────────────────────────────────────────

const CreatePriceTierDto = schema({
  name: [trim(), isString(), length(1, 50)],
});

const UpdatePriceTierDto = schema({
  name: [optional(), trim(), isString(), length(1, 50)],
  /** false deactivates the tier */
  isActive: [optional(), isBoolean()],
});

const ListPriceTiersQueryDto = schema({
  includeInactive: [optional(), queryBoolean(), isBoolean()],
});

/** One price for ONE of a unit of the product. */
const ProductPriceItemDto = schema({
  unitId: [isUuid()],
  priceTierId: [isUuid()],
  price: [isNumber({ maxDecimalPlaces: 2 }), isPositive(), max(MAX_MONEY)],
});

const ResolvePriceQueryDto = schema({
  partyId: [isUuid()],
  productId: [isUuid()],
  unitId: [isUuid()],
});

const ResolveItemDto = schema({
  productId: [isUuid()],
  unitId: [isUuid()],
});

const ResolveBulkDto = schema({
  partyId: [isUuid()],
  items: [isArray(), arrayMinSize(1), arrayMaxSize(200), nested(ResolveItemDto)],
});

// ─── Price resolution ───────────────────────────────────────────────────────

/**
 * The price resolution order, used by billing and the field app:
 * 1) party special price  2) tier price for the unit
 * 3) tier base-unit price × unit factor  4) nothing (null).
 * @param {{ special?: Decimal | null, tierPrice?: Decimal | null,
 *   baseTierPrice?: Decimal | null, unitFactor: Decimal }} c
 * @returns {{ price: Decimal, source: 'SPECIAL' | 'TIER' | 'DERIVED' } | null}
 */
export function pickPrice(c) {
  if (c.special != null) return { price: c.special, source: 'SPECIAL' };
  if (c.tierPrice != null) return { price: c.tierPrice, source: 'TIER' };
  if (c.baseTierPrice != null) {
    return {
      price: c.baseTierPrice.mul(c.unitFactor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      source: 'DERIVED',
    };
  }
  return null;
}

// ─── Service ────────────────────────────────────────────────────────────────

/** Audit entity used for product price changes; its rows are the price history. */
export const PRICE_AUDIT_ENTITY = 'ProductPrice';

const NO_PRICE = 'No price set';
const DUPLICATE_TIER = 'A price tier with this name already exists';

export function listTiers(actor, includeInactive = false) {
  return prisma.priceTier.findMany({
    where: { tenantId: actor.tenantId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
}

export async function createTier(actor, dto) {
  try {
    return await prisma.$transaction(async (tx) => {
      const tier = await tx.priceTier.create({ data: { tenantId: actor.tenantId, name: dto.name } });
      await auditLog(
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
    if (isUniqueViolation(e)) throw Conflict(DUPLICATE_TIER);
    throw e;
  }
}

export async function updateTier(actor, id, dto) {
  const before = await prisma.priceTier.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!before) throw NotFound('Price tier not found');
  try {
    return await prisma.$transaction(async (tx) => {
      const tier = await tx.priceTier.update({
        where: { id },
        data: { name: dto.name, isActive: dto.isActive },
      });
      await auditLog(
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
    if (isUniqueViolation(e)) throw Conflict(DUPLICATE_TIER);
    throw e;
  }
}

export async function getProductPrices(tenantId, productId) {
  const prices = await prisma.productPrice.findMany({
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
export async function setProductPrices(actor, productId, items) {
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId: actor.tenantId },
    include: { units: true },
  });
  if (!product) throw NotFound('Product not found');
  const tiers = await prisma.priceTier.findMany({ where: { tenantId: actor.tenantId } });

  const unitById = new Map(product.units.map((u) => [u.id, u]));
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  const seen = new Set();
  const errors = [];
  const rows = [];

  items.forEach((item, i) => {
    const unit = unitById.get(item.unitId);
    const tier = tierById.get(item.priceTierId);
    if (!unit) errors.push(`[${i}] unitId is not a unit of this product`);
    if (!tier) errors.push(`[${i}] priceTierId not found`);
    const key = `${item.unitId}:${item.priceTierId}`;
    if (seen.has(key)) errors.push(`[${i}] duplicate unit + tier in the list`);
    seen.add(key);
    if (unit && tier) {
      rows.push({
        unitId: unit.id,
        unitName: unit.name,
        priceTierId: tier.id,
        tierName: tier.name,
        price: new Decimal(item.price),
      });
    }
  });
  if (errors.length) throw BadRequest(errors);

  await prisma.$transaction((tx) => writePrices(tx, actor, productId, rows));
  return getProductPrices(actor.tenantId, productId);
}

/**
 * Upserts already-validated prices inside the caller's transaction. Unchanged
 * prices are skipped; every real change writes an audit row with the old and
 * new price, which is the product's price history. Returns how many changed.
 * @param {Array<{ unitId: string, unitName: string, priceTierId: string, tierName: string, price: Decimal }>} rows
 */
export async function writePrices(tx, actor, productId, rows) {
  const existing = await tx.productPrice.findMany({ where: { productId } });
  const byKey = new Map(existing.map((p) => [`${p.unitId}:${p.priceTierId}`, p]));
  let changed = 0;

  for (const row of rows) {
    const old = byKey.get(`${row.unitId}:${row.priceTierId}`);
    if (old?.price.equals(row.price)) continue;

    await tx.productPrice.upsert({
      where: {
        productId_unitId_priceTierId: { productId, unitId: row.unitId, priceTierId: row.priceTierId },
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
    await auditLog(
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

export async function priceHistory(actor, productId, query) {
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!product) throw NotFound('Product not found');

  const where = { tenantId: actor.tenantId, entity: PRICE_AUDIT_ENTITY, entityId: productId };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(query),
    }),
    prisma.auditLog.count({ where }),
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

/** GET /pricing/resolve: a single price, or a 404 / 422 error. */
export async function resolve(actor, partyId, productId, unitId) {
  const [item] = await resolveMany(actor, partyId, [{ productId, unitId }]);
  if (item.error === NO_PRICE) throw UnprocessableEntity(NO_PRICE);
  if (item.error) throw NotFound(item.error);
  return { price: item.price, source: item.source, unitName: item.unitName };
}

/**
 * Resolves many items for one party with a fixed number of queries.
 * Items that can't be priced carry an `error` instead of failing the batch.
 * @returns {Promise<Array<{ productId: string, unitId: string, unitName: string | null,
 *   price: string | null, source: string | null, error?: string }>>}
 */
export async function resolveMany(actor, partyId, items) {
  const party = await prisma.party.findFirst({
    where: { id: partyId, tenantId: actor.tenantId },
    include: { priceTier: true },
  });
  if (!party) throw NotFound('Party not found');
  // A deactivated tier no longer supplies prices.
  const tierId = party.priceTier?.isActive ? party.priceTierId : null;

  const productIds = [...new Set(items.map((i) => i.productId))];
  const [products, specials, tierPrices] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: actor.tenantId },
      include: { units: true },
    }),
    prisma.partyPrice.findMany({ where: { partyId, productId: { in: productIds } } }),
    tierId
      ? prisma.productPrice.findMany({ where: { priceTierId: tierId, productId: { in: productIds } } })
      : Promise.resolve([]),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const specialByKey = new Map(specials.map((s) => [`${s.productId}:${s.unitId}`, s.price]));
  const tierByKey = new Map(tierPrices.map((t) => [`${t.productId}:${t.unitId}`, t.price]));

  return items.map(({ productId, unitId }) => {
    const empty = { productId, unitId, price: null, source: null };
    const product = productById.get(productId);
    if (!product) return { ...empty, unitName: null, error: 'Product not found' };
    const unit = product.units.find((u) => u.id === unitId);
    if (!unit) return { ...empty, unitName: null, error: 'Unit not found for this product' };
    const baseUnit = product.units.find((u) => u.factor.equals(1));
    const picked = pickPrice({
      special: specialByKey.get(`${productId}:${unitId}`),
      tierPrice: tierByKey.get(`${productId}:${unitId}`),
      baseTierPrice: baseUnit ? tierByKey.get(`${productId}:${baseUnit.id}`) : null,
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

// ─── Routes ─────────────────────────────────────────────────────────────────

const tiers = controller('/price-tiers');
tiers.get('/', { query: ListPriceTiersQueryDto }, ({ user, query }) =>
  listTiers(user, query.includeInactive),
);
tiers.post('/', { roles: MASTER_DATA_WRITE_ROLES, body: CreatePriceTierDto }, ({ user, body }) =>
  createTier(user, body),
);
tiers.patch(
  '/:id',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' }, body: UpdatePriceTierDto },
  ({ user, params, body }) => updateTier(user, params.id, body),
);

const productPrices = controller('/products');
productPrices.get('/:id/prices', { params: { id: 'uuid' } }, ({ user, params }) =>
  getProductPrices(user.tenantId, params.id),
);
productPrices.put(
  '/:id/prices',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' }, bodyArray: ProductPriceItemDto },
  ({ user, params, body }) => setProductPrices(user, params.id, body),
);
productPrices.get(
  '/:id/price-history',
  { params: { id: 'uuid' }, query: PaginationQueryDto },
  ({ user, params, query }) => priceHistory(user, params.id, query),
);

const pricing = controller('/pricing');
pricing.get('/resolve', { query: ResolvePriceQueryDto }, ({ user, query }) =>
  resolve(user, query.partyId, query.productId, query.unitId),
);
pricing.post('/resolve-bulk', { status: 200, body: ResolveBulkDto }, ({ user, body }) =>
  resolveMany(user, body.partyId, body.items),
);

export const pricingRoutes = [tiers, productPrices, pricing];
