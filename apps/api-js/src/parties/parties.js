import { overdueInvoices, partyBalance } from '../accounts/outstanding.js';
import { auditLog } from '../common/audit.js';
import { pageArgs, paginationDefaults, paginationFields } from '../common/pagination.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import { AuditAction, Decimal, PartyType, prisma } from '../db.js';
import { BadRequest, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  isBoolean,
  isEnum,
  isInt,
  isNumber,
  isPositive,
  isString,
  isUuid,
  length,
  matches,
  max,
  min,
  optional,
  queryBoolean,
  schema,
  trim,
  validateIf,
} from '../http/validation.js';
import { MAX_MONEY } from '../pricing/pricing.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const PAN_REGEX = /^\d{9}$/;
const PAN_MESSAGE = 'panVatNo must be exactly 9 digits';
// Parties may give a landline ("01-4270000") as well as a mobile.
const PHONE_REGEX = /^[0-9+\- ]{6,20}$/;
const PHONE_MESSAGE = 'phone may only contain digits, spaces, + and - (6-20 characters)';

/** Present and not null: lets PATCH send null to clear a field. */
const isSet = () => validateIf((_, v) => v !== null && v !== undefined);
const money = () => [isNumber({ maxDecimalPlaces: 2 }), min(0), max(MAX_MONEY)];
const days = () => [isInt(), min(0), max(365)];

const CreatePartyDto = schema({
  type: [isEnum(PartyType)],
  name: [trim(), isString(), length(1, 200)],
  ownerName: [optional(), trim(), isString(), length(1, 200)],
  phone: [optional(), trim(), matches(PHONE_REGEX, PHONE_MESSAGE)],
  /** 9 digits */
  panVatNo: [optional(), trim(), matches(PAN_REGEX, PAN_MESSAGE)],
  address: [optional(), trim(), isString(), length(1, 300)],
  priceTierId: [optional(), isUuid()],
  creditLimit: [optional(), ...money()],
  creditDays: [optional(), ...days()],
  beatId: [optional(), isUuid()],
});

const UpdatePartyDto = schema({
  type: [optional(), isEnum(PartyType)],
  name: [optional(), trim(), isString(), length(1, 200)],
  ownerName: [isSet(), trim(), isString(), length(1, 200)],
  phone: [isSet(), trim(), matches(PHONE_REGEX, PHONE_MESSAGE)],
  panVatNo: [isSet(), trim(), matches(PAN_REGEX, PAN_MESSAGE)],
  address: [isSet(), trim(), isString(), length(1, 300)],
  priceTierId: [isSet(), isUuid()],
  creditLimit: [optional(), ...money()],
  creditDays: [optional(), ...days()],
  beatId: [isSet(), isUuid()],
  /** true re-activates a deactivated party */
  isActive: [optional(), isBoolean()],
});

const ListPartiesQueryDto = schema(
  {
    /** Matches name, phone or PAN */
    search: [optional(), trim(), isString(), length(1, 100)],
    /** CUSTOMER and SUPPLIER also include parties of type BOTH */
    type: [optional(), isEnum(PartyType)],
    beatId: [optional(), isUuid()],
    priceTierId: [optional(), isUuid()],
    /** Omit to list both active and inactive */
    isActive: [optional(), queryBoolean(), isBoolean()],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

/** Price for ONE of this unit. */
const SpecialPriceItemDto = schema({
  productId: [isUuid()],
  unitId: [isUuid()],
  price: [isNumber({ maxDecimalPlaces: 2 }), isPositive(), max(MAX_MONEY)],
});

// ─── Service ────────────────────────────────────────────────────────────────

// No balance here: it is derived from ledger_entries.
const PARTY_INCLUDE = {
  priceTier: { select: { id: true, name: true } },
  beat: { select: { id: true, name: true } },
};

/** Party plus its current balance (from the ledger) and what is overdue. */
export async function findOneWithBalance(actor, id) {
  const party = await findOne(actor, id);
  const [balance, overdue] = await Promise.all([
    partyBalance(prisma, actor.tenantId, id),
    overdueInvoices(prisma, actor.tenantId, id),
  ]);
  return {
    ...party,
    balance,
    overdueAmount: overdue.reduce((s, i) => s.plus(i.outstanding), new Decimal(0)),
    overdueInvoiceCount: overdue.length,
  };
}

export async function list(actor, q) {
  const where = {
    tenantId: actor.tenantId,
    beatId: q.beatId,
    priceTierId: q.priceTierId,
    isActive: q.isActive,
    // A BOTH party is a customer and a supplier.
    ...(q.type && {
      type: q.type === PartyType.BOTH ? q.type : { in: [q.type, PartyType.BOTH] },
    }),
    ...(q.search && {
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
        { panVatNo: { contains: q.search } },
      ],
    }),
  };
  const [items, total] = await Promise.all([
    prisma.party.findMany({ where, include: PARTY_INCLUDE, orderBy: { name: 'asc' }, ...pageArgs(q) }),
    prisma.party.count({ where }),
  ]);
  return { items, total, page: q.page, limit: q.limit };
}

export async function findOne(actor, id) {
  const party = await prisma.party.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: PARTY_INCLUDE,
  });
  if (!party) throw NotFound('Party not found');
  return party;
}

export async function create(actor, dto) {
  await assertRefs(actor, dto.priceTierId, dto.beatId);
  return prisma.$transaction(async (tx) => {
    const party = await tx.party.create({
      data: { ...dto, tenantId: actor.tenantId },
      include: PARTY_INCLUDE,
    });
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'Party',
        entityId: party.id,
        action: AuditAction.CREATE,
        newValue: party,
      },
      tx,
    );
    return party;
  });
}

export async function update(actor, id, dto) {
  const before = await findOne(actor, id);
  await assertRefs(actor, dto.priceTierId, dto.beatId);
  return prisma.$transaction(async (tx) => {
    const party = await tx.party.update({ where: { id }, data: dto, include: PARTY_INCLUDE });
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'Party',
        entityId: id,
        action: AuditAction.UPDATE,
        oldValue: before,
        newValue: party,
      },
      tx,
    );
    return party;
  });
}

export async function deactivate(actor, id) {
  const before = await findOne(actor, id);
  if (!before.isActive) return before;
  return update(actor, id, { isActive: false });
}

export async function listSpecialPrices(actor, partyId) {
  await findOne(actor, partyId);
  const rows = await prisma.partyPrice.findMany({
    where: { partyId, tenantId: actor.tenantId },
    include: {
      product: { select: { id: true, sku: true, name: true } },
      unit: { select: { id: true, name: true, factor: true } },
    },
    orderBy: { product: { name: 'asc' } },
  });
  return rows.map((r) => ({
    productId: r.productId,
    sku: r.product.sku,
    productName: r.product.name,
    unitId: r.unitId,
    unitName: r.unit.name,
    price: r.price.toFixed(2),
    updatedAt: r.updatedAt,
  }));
}

/** Upserts special prices for one party in one transaction; each change is audited. */
export async function setSpecialPrices(actor, partyId, items) {
  await findOne(actor, partyId);
  const products = await prisma.product.findMany({
    where: { tenantId: actor.tenantId, id: { in: [...new Set(items.map((i) => i.productId))] } },
    include: { units: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const errors = [];
  const seen = new Set();
  items.forEach((item, i) => {
    const product = productById.get(item.productId);
    if (!product) errors.push(`[${i}] product not found`);
    else if (!product.units.some((u) => u.id === item.unitId)) {
      errors.push(`[${i}] unitId is not a unit of this product`);
    }
    const key = `${item.productId}:${item.unitId}`;
    if (seen.has(key)) errors.push(`[${i}] duplicate product + unit in the list`);
    seen.add(key);
  });
  if (errors.length) throw BadRequest(errors);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.partyPrice.findMany({ where: { partyId } });
    const byKey = new Map(existing.map((p) => [`${p.productId}:${p.unitId}`, p]));
    for (const item of items) {
      const price = new Decimal(item.price);
      const old = byKey.get(`${item.productId}:${item.unitId}`);
      if (old?.price.equals(price)) continue;

      await tx.partyPrice.upsert({
        where: {
          partyId_productId_unitId: { partyId, productId: item.productId, unitId: item.unitId },
        },
        create: {
          tenantId: actor.tenantId,
          partyId,
          productId: item.productId,
          unitId: item.unitId,
          price,
        },
        update: { price },
      });
      const product = productById.get(item.productId);
      const label = {
        productId: product.id,
        sku: product.sku,
        unitId: item.unitId,
        unitName: product.units.find((u) => u.id === item.unitId).name,
      };
      await auditLog(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'PartyPrice',
          entityId: partyId,
          action: old ? AuditAction.UPDATE : AuditAction.CREATE,
          oldValue: old ? { ...label, price: old.price.toFixed(2) } : undefined,
          newValue: { ...label, price: price.toFixed(2) },
        },
        tx,
      );
    }
  });
  return listSpecialPrices(actor, partyId);
}

/** Removes a special price so the party falls back to its tier price. */
export async function removeSpecialPrice(actor, partyId, productId, unitId) {
  await findOne(actor, partyId);
  const row = await prisma.partyPrice.findFirst({
    where: { partyId, productId, unitId, tenantId: actor.tenantId },
    include: { product: true, unit: true },
  });
  if (!row) throw NotFound('No special price for this product and unit');

  await prisma.$transaction(async (tx) => {
    await tx.partyPrice.delete({ where: { id: row.id } });
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'PartyPrice',
        entityId: partyId,
        action: AuditAction.DELETE,
        oldValue: {
          productId,
          sku: row.product.sku,
          unitId,
          unitName: row.unit.name,
          price: row.price.toFixed(2),
        },
      },
      tx,
    );
  });
}

async function assertRefs(actor, priceTierId, beatId) {
  if (priceTierId) {
    const tier = await prisma.priceTier.findFirst({
      where: { id: priceTierId, tenantId: actor.tenantId, isActive: true },
    });
    if (!tier) throw BadRequest('Price tier not found');
  }
  if (beatId) {
    const beat = await prisma.beat.findFirst({ where: { id: beatId, tenantId: actor.tenantId } });
    if (!beat) throw BadRequest('Beat not found');
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const r = controller('/parties');

r.get('/', { query: ListPartiesQueryDto }, ({ user, query }) => list(user, query));
r.get('/:id', { params: { id: 'uuid' } }, ({ user, params }) => findOneWithBalance(user, params.id));
r.post('/', { roles: MASTER_DATA_WRITE_ROLES, body: CreatePartyDto }, ({ user, body }) =>
  create(user, body),
);
r.patch(
  '/:id',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' }, body: UpdatePartyDto },
  ({ user, params, body }) => update(user, params.id, body),
);
r.patch(
  '/:id/deactivate',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' } },
  ({ user, params }) => deactivate(user, params.id),
);
r.get('/:id/special-prices', { params: { id: 'uuid' } }, ({ user, params }) =>
  listSpecialPrices(user, params.id),
);
r.put(
  '/:id/special-prices',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' }, bodyArray: SpecialPriceItemDto },
  ({ user, params, body }) => setSpecialPrices(user, params.id, body),
);
r.delete(
  '/:id/special-prices/:productId/:unitId',
  { roles: MASTER_DATA_WRITE_ROLES, status: 204, params: { id: 'uuid', productId: 'uuid', unitId: 'uuid' } },
  ({ user, params }) => removeSpecialPrice(user, params.id, params.productId, params.unitId),
);

export const partiesRoutes = r;
