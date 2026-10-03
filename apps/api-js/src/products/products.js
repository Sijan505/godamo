import { auditLog } from '../common/audit.js';
import { pageArgs, paginationDefaults, paginationFields } from '../common/pagination.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import { AuditAction, Decimal, isUniqueViolation, prisma } from '../db.js';
import { BadRequest, Conflict, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  arrayMaxSize,
  arrayMinSize,
  custom,
  isArray,
  isBoolean,
  isNumber,
  isPositive,
  isString,
  isUuid,
  length,
  matches,
  max,
  min,
  nested,
  optional,
  queryBoolean,
  schema,
  trim,
  validateIf,
} from '../http/validation.js';
import { getProductPrices } from '../pricing/pricing.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const MAX_QTY = 99_999_999_999.999;

/** Unit and base-unit names are stored lowercase so "Box" and "box" are the same unit. */
const lowerTrim = () => custom((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v));

const BARCODE_REGEX = /^[A-Za-z0-9-]+$/;
const BARCODE_MESSAGE = 'barcode may only contain letters, digits and -';
const notNullish = (_, v) => v !== null && v !== undefined;
const quantity = () => [isNumber({ maxDecimalPlaces: 3 }), isPositive(), max(MAX_QTY)];

export const CreateUnitDto = schema({
  name: [lowerTrim(), isString(), length(1, 20)],
  /** How many BASE units are in one of this unit */
  factor: quantity(),
  isDefaultSale: [optional(), isBoolean()],
  isDefaultPurchase: [optional(), isBoolean()],
});

const UpdateUnitDto = schema({
  name: [optional(), lowerTrim(), isString(), length(1, 20)],
  /** Cannot change once the unit is used in any transaction */
  factor: [optional(), ...quantity()],
  /** true makes this the default sale unit (the old default is unset) */
  isDefaultSale: [optional(), isBoolean()],
  /** true makes this the default purchase unit (the old default is unset) */
  isDefaultPurchase: [optional(), isBoolean()],
});

const CreateProductDto = schema({
  sku: [trim(), isString(), length(1, 50)],
  barcode: [optional(), trim(), matches(BARCODE_REGEX, BARCODE_MESSAGE), length(1, 50)],
  name: [trim(), isString(), length(1, 200)],
  nameNepali: [optional(), trim(), isString(), length(1, 200)],
  categoryId: [isUuid()],
  brand: [optional(), trim(), isString(), length(1, 100)],
  /** Smallest unit; stock is kept in this unit */
  baseUnit: [lowerTrim(), isString(), length(1, 20)],
  vatApplicable: [optional(), isBoolean()],
  trackBatch: [optional(), isBoolean()],
  /** In the base unit */
  reorderLevel: [optional(), isNumber({ maxDecimalPlaces: 3 }), min(0), max(MAX_QTY)],
  units: [isArray(), arrayMinSize(1), arrayMaxSize(10), nested(CreateUnitDto)],
});

/** baseUnit can't be changed after creation: stock is already counted in it. */
const UpdateProductDto = schema({
  sku: [optional(), trim(), isString(), length(1, 50)],
  barcode: [validateIf(notNullish), trim(), matches(BARCODE_REGEX, BARCODE_MESSAGE), length(1, 50)],
  name: [optional(), trim(), isString(), length(1, 200)],
  nameNepali: [validateIf(notNullish), trim(), isString(), length(1, 200)],
  categoryId: [optional(), isUuid()],
  brand: [validateIf(notNullish), trim(), isString(), length(1, 100)],
  vatApplicable: [optional(), isBoolean()],
  trackBatch: [optional(), isBoolean()],
  reorderLevel: [optional(), isNumber({ maxDecimalPlaces: 3 }), min(0), max(MAX_QTY)],
  /** true re-activates a deactivated product */
  isActive: [optional(), isBoolean()],
});

const ListProductsQueryDto = schema(
  {
    /** Matches name, SKU or barcode */
    search: [optional(), trim(), isString(), length(1, 100)],
    categoryId: [optional(), isUuid()],
    brand: [optional(), trim(), isString(), length(1, 100)],
    /** Omit to list both active and inactive */
    isActive: [optional(), queryBoolean(), isBoolean()],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

// ─── Unit rules ─────────────────────────────────────────────────────────────

/**
 * Checks a product's full unit set. Returns human-readable errors (empty = valid):
 * - every factor > 0 and unit names unique (case-insensitive)
 * - exactly one unit has factor 1, and it is the product's base unit
 * - exactly one default sale unit and exactly one default purchase unit
 * @param {string} baseUnit
 * @param {Array<{ name: string, factor: Decimal | number | string,
 *   isDefaultSale?: boolean, isDefaultPurchase?: boolean }>} units
 */
export function validateUnitSet(baseUnit, units) {
  const errors = [];
  if (!units.length) return ['At least one unit is required'];

  const factors = units.map((u) => new Decimal(u.factor));
  if (factors.some((f) => f.lte(0))) errors.push('Every unit factor must be greater than 0');

  const names = units.map((u) => u.name.trim().toLowerCase());
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (duplicates.length) {
    errors.push(`Unit names must be unique (duplicate: ${duplicates.join(', ')})`);
  }

  const baseUnits = units.filter((_, i) => factors[i].equals(1));
  if (baseUnits.length !== 1) {
    errors.push(`Exactly one unit must have factor 1 (the base unit), found ${baseUnits.length}`);
  } else if (baseUnits[0].name.trim().toLowerCase() !== baseUnit.trim().toLowerCase()) {
    errors.push(
      `The unit with factor 1 must be the base unit "${baseUnit}", not "${baseUnits[0].name}"`,
    );
  }

  const sale = units.filter((u) => u.isDefaultSale).length;
  if (sale !== 1) errors.push(`Exactly one unit must be the default sale unit, found ${sale}`);
  const purchase = units.filter((u) => u.isDefaultPurchase).length;
  if (purchase !== 1) {
    errors.push(`Exactly one unit must be the default purchase unit, found ${purchase}`);
  }
  return errors;
}

// ─── Service ────────────────────────────────────────────────────────────────

const LIST_INCLUDE = {
  category: { select: { id: true, name: true } },
  units: { orderBy: { factor: 'asc' } },
};

export async function list(actor, q) {
  const where = {
    tenantId: actor.tenantId,
    categoryId: q.categoryId,
    isActive: q.isActive,
    ...(q.brand && { brand: { equals: q.brand, mode: 'insensitive' } }),
    ...(q.search && {
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { nameNepali: { contains: q.search, mode: 'insensitive' } },
        { sku: { contains: q.search, mode: 'insensitive' } },
        { barcode: q.search },
      ],
    }),
  };
  const [items, total] = await Promise.all([
    prisma.product.findMany({ where, include: LIST_INCLUDE, orderBy: { name: 'asc' }, ...pageArgs(q) }),
    prisma.product.count({ where }),
  ]);
  return { items, total, page: q.page, limit: q.limit };
}

/** Product with category, units (smallest first) and all tier prices. */
export async function findOne(actor, id) {
  const product = await prisma.product.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: LIST_INCLUDE,
  });
  if (!product) throw NotFound('Product not found');
  return withPrices(product);
}

export async function findByBarcode(actor, code) {
  const product = await prisma.product.findFirst({
    where: { tenantId: actor.tenantId, barcode: code },
    include: LIST_INCLUDE,
  });
  if (!product) throw NotFound('No product with this barcode');
  return withPrices(product);
}

export async function create(actor, dto) {
  const unitErrors = validateUnitSet(dto.baseUnit, dto.units);
  if (unitErrors.length) throw BadRequest(unitErrors);
  await assertCategory(actor, dto.categoryId);
  await assertUniqueCodes(actor.tenantId, dto.sku, dto.barcode);

  const { units, ...fields } = dto;
  try {
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          ...fields,
          tenantId: actor.tenantId,
          units: {
            create: units.map((u) => ({
              tenantId: actor.tenantId,
              name: u.name,
              factor: u.factor,
              isDefaultSale: !!u.isDefaultSale,
              isDefaultPurchase: !!u.isDefaultPurchase,
            })),
          },
        },
        include: LIST_INCLUDE,
      });
      await auditLog(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Product',
          entityId: created.id,
          action: AuditAction.CREATE,
          newValue: created,
        },
        tx,
      );
      return created;
    });
    return withPrices(product);
  } catch (e) {
    if (isUniqueViolation(e)) throw Conflict('SKU or barcode is already in use');
    throw e;
  }
}

export async function update(actor, id, dto) {
  const before = await getOwned(actor, id);
  if (dto.categoryId) await assertCategory(actor, dto.categoryId);
  await assertUniqueCodes(actor.tenantId, dto.sku, dto.barcode, id);

  try {
    await prisma.$transaction(async (tx) => {
      const after = await tx.product.update({ where: { id }, data: dto });
      await auditLog(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Product',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: before,
          newValue: after,
        },
        tx,
      );
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw Conflict('SKU or barcode is already in use');
    throw e;
  }
  return findOne(actor, id);
}

export async function deactivate(actor, id) {
  const before = await getOwned(actor, id);
  if (before.isActive) {
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { isActive: false } });
      await auditLog(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Product',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: { isActive: true },
          newValue: { isActive: false },
        },
        tx,
      );
    });
  }
  return findOne(actor, id);
}

export async function addUnit(actor, productId, dto) {
  const product = await getOwned(actor, productId, true);
  // Check the whole set as it would look after adding this unit.
  const next = [
    ...product.units.map((u) => ({
      name: u.name,
      factor: u.factor,
      isDefaultSale: dto.isDefaultSale ? false : u.isDefaultSale,
      isDefaultPurchase: dto.isDefaultPurchase ? false : u.isDefaultPurchase,
    })),
    dto,
  ];
  const errors = validateUnitSet(product.baseUnit, next);
  if (errors.length) throw BadRequest(errors);

  await prisma.$transaction(async (tx) => {
    await clearDefaults(tx, productId, dto);
    const unit = await tx.productUnit.create({
      data: {
        tenantId: actor.tenantId,
        productId,
        name: dto.name,
        factor: dto.factor,
        isDefaultSale: !!dto.isDefaultSale,
        isDefaultPurchase: !!dto.isDefaultPurchase,
      },
    });
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'ProductUnit',
        entityId: unit.id,
        action: AuditAction.CREATE,
        newValue: unit,
      },
      tx,
    );
  });
  return findOne(actor, productId);
}

export async function updateUnit(actor, productId, unitId, dto) {
  const product = await getOwned(actor, productId, true);
  const unit = product.units.find((u) => u.id === unitId);
  if (!unit) throw NotFound('Unit not found for this product');
  const isBase = unit.factor.equals(1);

  if (dto.name !== undefined && dto.name !== unit.name) {
    if (isBase) {
      throw BadRequest('The base unit cannot be renamed; it must match the product base unit');
    }
    if (product.units.some((u) => u.id !== unitId && u.name === dto.name)) {
      throw Conflict(`This product already has a unit named "${dto.name}"`);
    }
  }

  if (dto.factor !== undefined && !unit.factor.equals(dto.factor)) {
    if (isBase) throw BadRequest('The base unit factor must stay 1');
    if (new Decimal(dto.factor).equals(1)) throw BadRequest('Only the base unit can have factor 1');
    if (await isUnitUsed(prisma, unitId)) {
      throw Conflict(
        `Unit "${unit.name}" is already used in purchases, orders, invoices or returns, ` +
          'so its factor cannot be changed. Add a new unit with the new factor instead.',
      );
    }
  }

  if (
    (dto.isDefaultSale === false && unit.isDefaultSale) ||
    (dto.isDefaultPurchase === false && unit.isDefaultPurchase)
  ) {
    throw BadRequest(
      'A product always needs a default unit. Set another unit as the default instead.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await clearDefaults(tx, productId, dto);
    const after = await tx.productUnit.update({
      where: { id: unitId },
      data: {
        name: dto.name,
        factor: dto.factor,
        isDefaultSale: dto.isDefaultSale || undefined,
        isDefaultPurchase: dto.isDefaultPurchase || undefined,
      },
    });
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'ProductUnit',
        entityId: unitId,
        action: AuditAction.UPDATE,
        oldValue: unit,
        newValue: after,
      },
      tx,
    );
  });
  return findOne(actor, productId);
}

/** True if any purchase, order, invoice or return line uses this unit. */
export async function isUnitUsed(db, unitId) {
  const counts = await Promise.all([
    db.purchaseItem.count({ where: { unitId } }),
    db.salesOrderItem.count({ where: { unitId } }),
    db.invoiceItem.count({ where: { unitId } }),
    db.salesReturnItem.count({ where: { unitId } }),
  ]);
  return counts.some((c) => c > 0);
}

async function getOwned(actor, id, withUnits = false) {
  const product = await prisma.product.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: { units: withUnits },
  });
  if (!product) throw NotFound('Product not found');
  return product;
}

async function withPrices(product) {
  return { ...product, prices: await getProductPrices(product.tenantId, product.id) };
}

async function assertCategory(actor, categoryId) {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, tenantId: actor.tenantId },
  });
  if (!category) throw BadRequest('Category not found');
}

async function assertUniqueCodes(tenantId, sku, barcode, excludeId) {
  const not = excludeId ? { id: { not: excludeId } } : {};
  if (sku) {
    const clash = await prisma.product.findFirst({ where: { tenantId, sku, ...not }, select: { id: true } });
    if (clash) throw Conflict(`SKU "${sku}" is already in use`);
  }
  if (barcode) {
    const clash = await prisma.product.findFirst({
      where: { tenantId, barcode, ...not },
      select: { id: true },
    });
    if (clash) throw Conflict(`Barcode "${barcode}" is already in use`);
  }
}

// Setting a new default sale/purchase unit unsets the old one.
async function clearDefaults(tx, productId, flags) {
  if (flags.isDefaultSale) {
    await tx.productUnit.updateMany({ where: { productId }, data: { isDefaultSale: false } });
  }
  if (flags.isDefaultPurchase) {
    await tx.productUnit.updateMany({ where: { productId }, data: { isDefaultPurchase: false } });
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const r = controller('/products');

r.get('/', { query: ListProductsQueryDto }, ({ user, query }) => list(user, query));
r.get('/barcode/:code', ({ user, params }) => findByBarcode(user, params.code));
r.get('/:id', { params: { id: 'uuid' } }, ({ user, params }) => findOne(user, params.id));
r.post('/', { roles: MASTER_DATA_WRITE_ROLES, body: CreateProductDto }, ({ user, body }) =>
  create(user, body),
);
r.patch(
  '/:id',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' }, body: UpdateProductDto },
  ({ user, params, body }) => update(user, params.id, body),
);
r.patch(
  '/:id/deactivate',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' } },
  ({ user, params }) => deactivate(user, params.id),
);
r.post(
  '/:id/units',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' }, body: CreateUnitDto },
  ({ user, params, body }) => addUnit(user, params.id, body),
);
r.patch(
  '/:id/units/:unitId',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid', unitId: 'uuid' }, body: UpdateUnitDto },
  ({ user, params, body }) => updateUnit(user, params.id, params.unitId, body),
);

export const productsRoutes = r;
