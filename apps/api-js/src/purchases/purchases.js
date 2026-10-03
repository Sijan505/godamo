import { auditLog } from '../common/audit.js';
import { calculateBill } from '../common/billing.js';
import { dateOnly as toDateOnly, nepalToday } from '../common/dates.js';
import { postLedger } from '../common/ledger.js';
import { pageArgs, paginationDefaults, paginationFields } from '../common/pagination.js';
import {
  AuditAction,
  Decimal,
  LedgerEntryType,
  MovementType,
  PartyType,
  PurchaseStatus,
  UserRole,
  isUniqueViolation,
  prisma,
} from '../db.js';
import { getActiveGodown } from '../godowns/godowns.js';
import { BadRequest, Conflict, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  arrayMaxSize,
  arrayMinSize,
  dateOnly,
  isArray,
  isEnum,
  isNumber,
  isPositive,
  isString,
  isUuid,
  length,
  max,
  min,
  nested,
  optional,
  schema,
  trim,
} from '../http/validation.js';
import { MAX_MONEY } from '../pricing/pricing.js';
import { InsufficientStockError, postMovements, reverseMovements } from '../stock/stock-engine.js';
import { baseQuantity, loadProducts } from '../stock/stock-lines.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

export const MAX_QTY = 99_999_999_999.999;
const money = () => [isNumber({ maxDecimalPlaces: 2 }), min(0), max(MAX_MONEY)];

const PurchaseItemDto = schema({
  productId: [isUuid()],
  unitId: [isUuid()],
  /** In the chosen unit */
  quantity: [isNumber({ maxDecimalPlaces: 3 }), isPositive(), max(MAX_QTY)],
  /** Price for ONE of the chosen unit, before VAT */
  rate: money(),
  /** Line discount amount */
  discount: [optional(), ...money()],
  /** Required for batch-tracked products */
  batchNo: [optional(), trim(), isString(), length(1, 50)],
  expiryDate: [optional(), dateOnly()],
  mfgDate: [optional(), dateOnly()],
});

const CreatePurchaseDto = schema({
  supplierId: [isUuid()],
  godownId: [isUuid()],
  supplierBillNo: [trim(), isString(), length(1, 50)],
  purchaseDate: [dateOnly()],
  /** Bill-level discount amount */
  discount: [optional(), ...money()],
  items: [isArray(), arrayMinSize(1), arrayMaxSize(200), nested(PurchaseItemDto)],
});

const CancelPurchaseDto = schema({
  reason: [trim(), isString(), length(3, 500)],
});

const ListPurchasesQueryDto = schema(
  {
    supplierId: [optional(), isUuid()],
    /** Purchase date from (inclusive) */
    from: [optional(), dateOnly()],
    /** Purchase date to (inclusive) */
    to: [optional(), dateOnly()],
    status: [optional(), isEnum(PurchaseStatus)],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

// ─── Service ────────────────────────────────────────────────────────────────

export const PURCHASE_REF = 'PURCHASE';

const DETAIL_INCLUDE = {
  supplier: { select: { id: true, name: true, panVatNo: true } },
  godown: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  items: {
    include: {
      product: { select: { id: true, sku: true, name: true, baseUnit: true } },
      unit: { select: { id: true, name: true, factor: true } },
      batch: { select: { id: true, batchNo: true, expiryDate: true } },
    },
  },
};

export async function list(actor, q) {
  const where = {
    tenantId: actor.tenantId,
    supplierId: q.supplierId,
    status: q.status,
    ...((q.from || q.to) && {
      purchaseDate: {
        ...(q.from && { gte: toDateOnly(q.from) }),
        ...(q.to && { lte: toDateOnly(q.to) }),
      },
    }),
  };
  const [items, total] = await Promise.all([
    prisma.purchase.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        godown: { select: { id: true, name: true } },
      },
      orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
      ...pageArgs(q),
    }),
    prisma.purchase.count({ where }),
  ]);
  return { items, total, page: q.page, limit: q.limit };
}

export async function findOne(actor, id) {
  const purchase = await prisma.purchase.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: DETAIL_INCLUDE,
  });
  if (!purchase) throw NotFound('Purchase not found');
  return purchase;
}

/**
 * Records a supplier bill. In ONE transaction: batches, purchase + items,
 * PURCHASE stock movements, a CREDIT ledger entry for the supplier, audit.
 */
export async function create(actor, dto) {
  const supplier = await prisma.party.findFirst({
    where: { id: dto.supplierId, tenantId: actor.tenantId },
  });
  if (!supplier) throw BadRequest('Supplier not found');
  if (supplier.type === PartyType.CUSTOMER) throw BadRequest(`${supplier.name} is not a supplier`);
  if (!supplier.isActive) throw BadRequest(`Supplier ${supplier.name} is inactive`);
  const godown = await getActiveGodown(actor, dto.godownId);
  await assertNewBill(actor.tenantId, supplier.id, dto.supplierBillNo);

  const products = await loadProducts(
    prisma,
    actor.tenantId,
    dto.items.map((i) => i.productId),
  );
  const lines = dto.items.map((item, i) => {
    const product = products.get(item.productId);
    if (!product.isActive) throw BadRequest(`Item ${i + 1}: ${product.name} is inactive`);
    if (product.trackBatch && !item.batchNo) {
      throw BadRequest(`Item ${i + 1}: batchNo is required for ${product.name} (batch-tracked)`);
    }
    if (!product.trackBatch && (item.batchNo || item.expiryDate)) {
      throw BadRequest(
        `Item ${i + 1}: ${product.name} is not batch-tracked; remove batchNo/expiryDate`,
      );
    }
    return { item, product, baseQty: baseQuantity(product, item.unitId, item.quantity) };
  });

  let totals;
  try {
    totals = calculateBill(
      lines.map(({ item, product }) => ({
        quantity: new Decimal(item.quantity),
        rate: new Decimal(item.rate),
        discount: new Decimal(item.discount ?? 0),
        vatApplicable: product.vatApplicable,
      })),
      new Decimal(dto.discount ?? 0),
    );
  } catch (e) {
    if (e instanceof RangeError) throw BadRequest(e.message);
    throw e;
  }

  try {
    const purchase = await prisma.$transaction(
      async (tx) => {
        const rows = [];
        for (const [i, { item, product, baseQty }] of lines.entries()) {
          // Cost per BASE unit excludes VAT (it is claimed back as input credit).
          const unitCost = totals.lines[i].taxable.div(baseQty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
          const batchId = product.trackBatch
            ? await findOrCreateBatch(tx, actor.tenantId, product, item, unitCost)
            : null;
          rows.push({ item, product, baseQty, unitCost, batchId, t: totals.lines[i] });
        }

        const created = await tx.purchase.create({
          data: {
            tenantId: actor.tenantId,
            supplierId: supplier.id,
            godownId: godown.id,
            supplierBillNo: dto.supplierBillNo,
            purchaseDate: toDateOnly(dto.purchaseDate),
            subtotal: totals.subtotal,
            discount: totals.discount,
            vatAmount: totals.vatAmount,
            total: totals.total,
            createdById: actor.userId,
            items: {
              create: rows.map((r) => ({
                tenantId: actor.tenantId,
                productId: r.product.id,
                unitId: r.item.unitId,
                batchId: r.batchId,
                quantity: r.item.quantity,
                baseQuantity: r.baseQty,
                rate: r.item.rate,
                discount: r.item.discount ?? 0,
                amount: r.t.amount,
                vatAmount: r.t.vatAmount,
              })),
            },
          },
        });

        await postMovements(
          tx,
          rows.map((r) => ({
            tenantId: actor.tenantId,
            godownId: godown.id,
            productId: r.product.id,
            batchId: r.batchId,
            type: MovementType.PURCHASE,
            quantity: r.baseQty,
            unitCost: r.unitCost,
            refType: PURCHASE_REF,
            refId: created.id,
            createdById: actor.userId,
          })),
        );

        // We now owe the supplier the bill total.
        await postLedger(tx, {
          tenantId: actor.tenantId,
          partyId: supplier.id,
          entryDate: created.purchaseDate,
          type: LedgerEntryType.PURCHASE,
          credit: totals.total,
          refType: PURCHASE_REF,
          refId: created.id,
          narration: `Purchase bill ${dto.supplierBillNo}`,
        });

        await auditLog(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Purchase',
            entityId: created.id,
            action: AuditAction.CREATE,
            newValue: {
              supplierId: supplier.id,
              supplierBillNo: dto.supplierBillNo,
              godownId: godown.id,
              total: totals.total,
              items: rows.length,
            },
          },
          tx,
        );
        return created;
      },
      { timeout: 30_000 },
    );
    return findOne(actor, purchase.id);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw Conflict(`Bill ${dto.supplierBillNo} from this supplier is already entered`);
    }
    throw e;
  }
}

/**
 * Cancels a purchase: reverses its stock and posts an opposite (DEBIT) ledger
 * entry, in one transaction. Fails if the stock has already been sold or moved.
 */
export async function cancel(actor, id, reason) {
  const purchase = await findOne(actor, id);
  if (purchase.status === PurchaseStatus.CANCELLED) {
    throw Conflict('This purchase is already cancelled');
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        // Conditional update: a concurrent cancel can't also succeed.
        const { count } = await tx.purchase.updateMany({
          where: { id, tenantId: actor.tenantId, status: PurchaseStatus.POSTED },
          data: {
            status: PurchaseStatus.CANCELLED,
            cancelReason: reason,
            cancelledAt: new Date(),
            cancelledById: actor.userId,
          },
        });
        if (count === 0) throw Conflict('This purchase is already cancelled');

        await reverseMovements(tx, actor.tenantId, PURCHASE_REF, id, actor.userId);
        await postLedger(tx, {
          tenantId: actor.tenantId,
          partyId: purchase.supplierId,
          entryDate: nepalToday(),
          type: LedgerEntryType.PURCHASE,
          debit: purchase.total,
          refType: PURCHASE_REF,
          refId: id,
          narration: `Purchase bill ${purchase.supplierBillNo} cancelled: ${reason}`,
        });
        await auditLog(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Purchase',
            entityId: id,
            action: AuditAction.CANCEL,
            oldValue: { status: PurchaseStatus.POSTED },
            newValue: { status: PurchaseStatus.CANCELLED, reason },
          },
          tx,
        );
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    if (e instanceof InsufficientStockError) {
      throw Conflict(
        `Cannot cancel this purchase: some of its stock has already been sold or moved. ${e.message}`,
      );
    }
    throw e;
  }
  return findOne(actor, id);
}

async function assertNewBill(tenantId, supplierId, billNo) {
  const existing = await prisma.purchase.findFirst({
    where: { tenantId, supplierId, supplierBillNo: billNo },
    select: { status: true },
  });
  if (existing) {
    throw Conflict(
      `Bill ${billNo} from this supplier is already entered` +
        (existing.status === PurchaseStatus.CANCELLED
          ? ' (it was cancelled; cancelled bill numbers cannot be reused)'
          : ''),
    );
  }
}

async function findOrCreateBatch(tx, tenantId, product, item, unitCost) {
  const existing = await tx.batch.findUnique({
    where: { productId_batchNo: { productId: product.id, batchNo: item.batchNo } },
  });
  if (existing) {
    const given = item.expiryDate ? toDateOnly(item.expiryDate).getTime() : null;
    if (given !== null && existing.expiryDate?.getTime() !== given) {
      throw BadRequest(
        `${product.name} batch ${item.batchNo} already exists with expiry ` +
          `${existing.expiryDate?.toISOString().slice(0, 10) ?? 'not set'}`,
      );
    }
    return existing.id;
  }
  const batch = await tx.batch.create({
    data: {
      tenantId,
      productId: product.id,
      batchNo: item.batchNo,
      expiryDate: item.expiryDate ? toDateOnly(item.expiryDate) : null,
      mfgDate: item.mfgDate ? toDateOnly(item.mfgDate) : null,
      costPrice: unitCost,
    },
  });
  return batch.id;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const r = controller('/purchases', {
  roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE, UserRole.GODOWN],
});

r.get('/', { query: ListPurchasesQueryDto }, ({ user, query }) => list(user, query));
r.get('/:id', { params: { id: 'uuid' } }, ({ user, params }) => findOne(user, params.id));
r.post('/', { body: CreatePurchaseDto }, ({ user, body }) => create(user, body));
r.post(
  '/:id/cancel',
  { roles: [UserRole.OWNER, UserRole.MANAGER], status: 200, params: { id: 'uuid' }, body: CancelPurchaseDto },
  ({ user, params, body }) => cancel(user, params.id, body.reason),
);

export const purchasesRoutes = r;
