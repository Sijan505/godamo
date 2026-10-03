import { auditLog } from '../common/audit.js';
import { pageArgs } from '../common/pagination.js';
import { fromBase } from '../common/units.js';
import { AuditAction, Decimal, MovementType, StockCountStatus, prisma } from '../db.js';
import { getActiveGodown } from '../godowns/godowns.js';
import { BadRequest, Conflict, NotFound } from '../http/errors.js';
import { allocateFEFO, averageCosts, getBalance, postMovements } from './stock-engine.js';
import { assertBatch, baseQuantity, loadProducts } from './stock-lines.js';

const TX_OPTIONS = { timeout: 30_000 };

export const TRANSFER_REF = 'TRANSFER';
export const ADJUSTMENT_REF = 'ADJUSTMENT';
export const STOCK_COUNT_REF = 'STOCK_COUNT';

// ─── Transfers ──────────────────────────────────────────────────────────────

/** TRANSFER_OUT + TRANSFER_IN pairs in one transaction, sharing one refId. */
export async function transfer(actor, dto) {
  if (dto.fromGodownId === dto.toGodownId) {
    throw BadRequest('From and to godown must be different');
  }
  const from = await getActiveGodown(actor, dto.fromGodownId, 'From godown');
  const to = await getActiveGodown(actor, dto.toGodownId, 'To godown');
  const products = await loadProducts(
    prisma,
    actor.tenantId,
    dto.items.map((i) => i.productId),
  );
  const lines = dto.items.map((item) => {
    const product = products.get(item.productId);
    assertBatchUsage(product, item.batchId);
    return { item, product, baseQty: baseQuantity(product, item.unitId, item.quantity) };
  });

  const doc = await prisma.$transaction(async (tx) => {
    const created = await tx.stockTransfer.create({
      data: {
        tenantId: actor.tenantId,
        fromGodownId: from.id,
        toGodownId: to.id,
        note: dto.note,
        createdById: actor.userId,
      },
    });
    const costs = await averageCosts(tx, actor.tenantId, [...products.keys()]);

    // Line by line, so a later line's FEFO pick sees earlier lines' stock-outs.
    for (const { item, product, baseQty } of lines) {
      const picks = await pickBatches(tx, actor, from.id, product, baseQty, item.batchId);
      const common = {
        tenantId: actor.tenantId,
        productId: product.id,
        unitCost: costs.get(product.id) ?? new Decimal(0),
        refType: TRANSFER_REF,
        refId: created.id,
        createdById: actor.userId,
      };
      await postMovements(
        tx,
        picks.flatMap((p) => [
          { ...common, godownId: from.id, batchId: p.batchId, type: MovementType.TRANSFER_OUT, quantity: p.qty.neg() },
          { ...common, godownId: to.id, batchId: p.batchId, type: MovementType.TRANSFER_IN, quantity: p.qty },
        ]),
      );
    }

    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'StockTransfer',
        entityId: created.id,
        action: AuditAction.CREATE,
        newValue: { ...dto, fromGodown: from.name, toGodown: to.name },
      },
      tx,
    );
    return created;
  }, TX_OPTIONS);

  return documentWithMovements(actor, TRANSFER_REF, doc.id, doc);
}

// ─── Adjustments ────────────────────────────────────────────────────────────

export async function adjust(actor, dto) {
  const godown = await getActiveGodown(actor, dto.godownId);
  const products = await loadProducts(
    prisma,
    actor.tenantId,
    dto.items.map((i) => i.productId),
  );
  const lines = dto.items.map((item, i) => {
    const product = products.get(item.productId);
    if (dto.type === MovementType.DAMAGE && item.quantity > 0) {
      throw BadRequest(`Item ${i + 1}: DAMAGE quantities must be negative (stock going out)`);
    }
    assertBatchUsage(product, item.batchId);
    if (product.trackBatch && item.quantity > 0 && !item.batchId) {
      throw BadRequest(
        `Item ${i + 1}: batchId is required to add stock of ${product.name} (batch-tracked)`,
      );
    }
    const baseQty = baseQuantity(product, item.unitId, Math.abs(item.quantity));
    return { item, product, baseQty, out: item.quantity < 0 };
  });

  const doc = await prisma.$transaction(async (tx) => {
    const created = await tx.stockAdjustment.create({
      data: {
        tenantId: actor.tenantId,
        godownId: godown.id,
        type: dto.type,
        reason: dto.reason,
        createdById: actor.userId,
      },
    });
    const costs = await averageCosts(tx, actor.tenantId, [...products.keys()]);

    for (const { item, product, baseQty, out } of lines) {
      const picks = out
        ? await pickBatches(tx, actor, godown.id, product, baseQty, item.batchId)
        : [{ batchId: item.batchId ?? null, qty: baseQty }];
      await postMovements(
        tx,
        picks.map((p) => ({
          tenantId: actor.tenantId,
          godownId: godown.id,
          productId: product.id,
          batchId: p.batchId,
          type: dto.type,
          quantity: out ? p.qty.neg() : p.qty,
          unitCost: costs.get(product.id) ?? new Decimal(0),
          refType: ADJUSTMENT_REF,
          refId: created.id,
          createdById: actor.userId,
        })),
      );
    }

    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'StockAdjustment',
        entityId: created.id,
        action: AuditAction.CREATE,
        newValue: { ...dto, godown: godown.name },
      },
      tx,
    );
    return created;
  }, TX_OPTIONS);

  return documentWithMovements(actor, ADJUSTMENT_REF, doc.id, doc);
}

// ─── Counts ─────────────────────────────────────────────────────────────────

/** Records a physical count and freezes the differences against system stock. */
export async function createCount(actor, dto) {
  const godown = await getActiveGodown(actor, dto.godownId);
  const products = await loadProducts(
    prisma,
    actor.tenantId,
    dto.items.map((i) => i.productId),
  );
  const seen = new Set();
  const rows = [];
  for (const [i, item] of dto.items.entries()) {
    const product = products.get(item.productId);
    assertBatchUsage(product, item.batchId);
    if (product.trackBatch && !item.batchId) {
      throw BadRequest(`Item ${i + 1}: count ${product.name} per batch (batchId is required)`);
    }
    if (item.batchId) await assertBatch(prisma, actor.tenantId, product, item.batchId);
    const key = `${product.id}:${item.batchId ?? ''}`;
    if (seen.has(key)) throw BadRequest(`Item ${i + 1}: ${product.name} is listed twice`);
    seen.add(key);

    const countedBaseQty = baseQuantity(product, item.unitId, item.countedQty);
    const systemBaseQty = await getBalance(prisma, actor.tenantId, godown.id, product.id, item.batchId);
    rows.push({
      tenantId: actor.tenantId,
      productId: product.id,
      batchId: item.batchId ?? null,
      unitId: item.unitId,
      countedQty: new Decimal(item.countedQty),
      countedBaseQty,
      systemBaseQty,
      differenceBaseQty: countedBaseQty.minus(systemBaseQty),
    });
  }

  const count = await prisma.$transaction(async (tx) => {
    const created = await tx.stockCount.create({
      data: {
        tenantId: actor.tenantId,
        godownId: godown.id,
        note: dto.note,
        createdById: actor.userId,
        items: { create: rows },
      },
    });
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'StockCount',
        entityId: created.id,
        action: AuditAction.CREATE,
        newValue: { godown: godown.name, items: rows },
      },
      tx,
    );
    return created;
  });
  return findCount(actor, count.id);
}

export async function listCounts(actor, q) {
  const where = { tenantId: actor.tenantId, godownId: q.godownId, status: q.status };
  const [items, total] = await Promise.all([
    prisma.stockCount.findMany({
      where,
      include: {
        godown: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(q),
    }),
    prisma.stockCount.count({ where }),
  ]);
  return { items, total, page: q.page, limit: q.limit };
}

/** A count with each line's system / counted / difference, also as unit breakdowns. */
export async function findCount(actor, id) {
  const count = await prisma.stockCount.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: {
      godown: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      appliedBy: { select: { id: true, name: true } },
      items: {
        include: {
          product: { include: { units: true } },
          unit: { select: { id: true, name: true } },
          batch: { select: { id: true, batchNo: true, expiryDate: true } },
        },
      },
    },
  });
  if (!count) throw NotFound('Stock count not found');

  const { items, ...header } = count;
  return {
    ...header,
    items: items.map(({ product, ...item }) => {
      const text = (q) => (q.lt(0) ? '-' : '') + fromBase(q.abs(), product.units).text;
      return {
        ...item,
        product: { id: product.id, sku: product.sku, name: product.name, baseUnit: product.baseUnit },
        systemText: text(item.systemBaseQty),
        countedText: text(item.countedBaseQty),
        differenceText: item.differenceBaseQty.isZero()
          ? 'no difference'
          : (item.differenceBaseQty.gt(0) ? '+' : '') + text(item.differenceBaseQty),
      };
    }),
  };
}

/** Posts ADJUSTMENT movements for every non-zero difference of a pending count. */
export async function applyCount(actor, id) {
  const count = await prisma.stockCount.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: { items: true },
  });
  if (!count) throw NotFound('Stock count not found');
  if (count.status === StockCountStatus.APPLIED) {
    throw Conflict('This stock count has already been applied');
  }

  await prisma.$transaction(async (tx) => {
    const { count: updated } = await tx.stockCount.updateMany({
      where: { id, status: StockCountStatus.PENDING },
      data: { status: StockCountStatus.APPLIED, appliedById: actor.userId, appliedAt: new Date() },
    });
    if (!updated) throw Conflict('This stock count has already been applied');

    const diffs = count.items.filter((i) => !i.differenceBaseQty.isZero());
    const costs = await averageCosts(
      tx,
      actor.tenantId,
      diffs.map((d) => d.productId),
    );
    await postMovements(
      tx,
      diffs.map((d) => ({
        tenantId: actor.tenantId,
        godownId: count.godownId,
        productId: d.productId,
        batchId: d.batchId,
        type: MovementType.ADJUSTMENT,
        quantity: d.differenceBaseQty,
        unitCost: costs.get(d.productId) ?? new Decimal(0),
        refType: STOCK_COUNT_REF,
        refId: id,
        createdById: actor.userId,
      })),
    );
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'StockCount',
        entityId: id,
        action: AuditAction.UPDATE,
        oldValue: { status: StockCountStatus.PENDING },
        newValue: { status: StockCountStatus.APPLIED, adjustedLines: diffs.length },
      },
      tx,
    );
  }, TX_OPTIONS);
  return findCount(actor, id);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function assertBatchUsage(product, batchId) {
  if (batchId && !product.trackBatch) {
    throw BadRequest(`${product.name} is not batch-tracked; remove batchId`);
  }
}

/** Batches to take `baseQty` from: the given batch, or FEFO for tracked products. */
async function pickBatches(tx, actor, godownId, product, baseQty, batchId) {
  if (!product.trackBatch) return [{ batchId: null, qty: baseQty }];
  if (batchId) {
    await assertBatch(tx, actor.tenantId, product, batchId);
    return [{ batchId, qty: baseQty }];
  }
  return allocateFEFO(tx, actor.tenantId, godownId, product.id, baseQty);
}

async function documentWithMovements(actor, refType, refId, doc) {
  const movements = await prisma.stockMovement.findMany({
    where: { tenantId: actor.tenantId, refType, refId },
    include: {
      product: { select: { id: true, sku: true, name: true } },
      godown: { select: { id: true, name: true } },
      batch: { select: { id: true, batchNo: true, expiryDate: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return { ...doc, movements };
}
