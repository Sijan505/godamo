import { addDays, nepalDayStart, nepalToday, nepalTodayString } from '../common/dates.js';
import { pageArgs } from '../common/pagination.js';
import { fromBase } from '../common/units.js';
import { Decimal, Prisma, prisma } from '../db.js';
import { NotFound } from '../http/errors.js';
import { averageCosts } from './stock-engine.js';

const round2 = (d) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const MAX_CARD_ROWS = 5000;

/** Signed breakdown text; fromBase already prefixes "-" for negatives. */
const breakdown = (qty, units) => fromBase(qty, units).text;

// Weighted average cost per BASE unit, from OPENING + PURCHASE movements.
const avgCostCte = (tenantId) => Prisma.sql`
  cost AS (
    SELECT product_id,
           SUM(quantity * unit_cost) / NULLIF(SUM(quantity), 0) AS avg_cost
    FROM stock_movements
    WHERE tenant_id = ${tenantId} AND type IN ('OPENING', 'PURCHASE')
    GROUP BY product_id
  )`;

/** Stock per product: base qty, unit breakdown, value, and per-godown split. */
export async function list(actor, q) {
  const where = {
    tenantId: actor.tenantId,
    isActive: true,
    categoryId: q.categoryId,
    ...(q.search && {
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { sku: { contains: q.search, mode: 'insensitive' } },
        { barcode: q.search },
      ],
    }),
  };
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: { units: true, category: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
      ...pageArgs(q),
    }),
    prisma.product.count({ where }),
  ]);
  const ids = products.map((p) => p.id);
  if (!ids.length) return { items: [], total, page: q.page, limit: q.limit };

  const [rows, costs] = await Promise.all([
    prisma.$queryRaw`
      SELECT m.product_id, m.godown_id, g.name AS godown_name, SUM(m.quantity) AS qty
      FROM stock_movements m
      JOIN godowns g ON g.id = m.godown_id
      WHERE m.tenant_id = ${actor.tenantId}
        AND m.product_id = ANY(${ids}::text[])
        ${q.godownId ? Prisma.sql`AND m.godown_id = ${q.godownId}` : Prisma.empty}
      GROUP BY m.product_id, m.godown_id, g.name`,
    averageCosts(prisma, actor.tenantId, ids),
  ]);

  const items = products.map((p) => {
    const byGodown = rows
      .filter((r) => r.product_id === p.id && !r.qty.isZero())
      .map((r) => ({
        godownId: r.godown_id,
        godownName: r.godown_name,
        qty: r.qty,
        text: breakdown(r.qty, p.units),
      }));
    const qty = byGodown.reduce((s, g) => s.plus(g.qty), new Decimal(0));
    const avgCost = costs.get(p.id) ?? new Decimal(0);
    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      baseUnit: p.baseUnit,
      baseQty: qty,
      text: breakdown(qty, p.units),
      avgCost,
      value: round2(qty.mul(avgCost)),
      byGodown,
    };
  });
  return { items, total, page: q.page, limit: q.limit };
}

/** Every movement of a product with a running balance (dates are Nepal days). */
export async function card(actor, productId, q) {
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId: actor.tenantId },
    include: { units: true },
  });
  if (!product) throw NotFound('Product not found');

  const fromAt = q.from ? nepalDayStart(q.from) : undefined;
  const toAt = q.to ? addDays(nepalDayStart(q.to), 1) : undefined;
  const base = { tenantId: actor.tenantId, productId, godownId: q.godownId };

  const opening = fromAt
    ? ((
        await prisma.stockMovement.aggregate({
          where: { ...base, createdAt: { lt: fromAt } },
          _sum: { quantity: true },
        })
      )._sum.quantity ?? new Decimal(0))
    : new Decimal(0);

  const movements = await prisma.stockMovement.findMany({
    where: {
      ...base,
      ...((fromAt || toAt) && {
        createdAt: { ...(fromAt && { gte: fromAt }), ...(toAt && { lt: toAt }) },
      }),
    },
    include: {
      godown: { select: { id: true, name: true } },
      batch: { select: { id: true, batchNo: true, expiryDate: true } },
      createdBy: { select: { id: true, name: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_CARD_ROWS + 1,
  });
  const truncated = movements.length > MAX_CARD_ROWS;
  if (truncated) movements.pop();

  let balance = opening;
  const lines = movements.map((m) => {
    balance = balance.plus(m.quantity);
    return {
      id: m.id,
      at: m.createdAt,
      type: m.type,
      godown: m.godown,
      batch: m.batch,
      in: m.quantity.gt(0) ? m.quantity : new Decimal(0),
      out: m.quantity.lt(0) ? m.quantity.neg() : new Decimal(0),
      balance,
      refType: m.refType,
      refId: m.refId,
      isReversal: !!m.reversalOfId,
      by: m.createdBy,
    };
  });

  return {
    product: { id: product.id, sku: product.sku, name: product.name, baseUnit: product.baseUnit },
    godownId: q.godownId ?? null,
    from: q.from ?? null,
    to: q.to ?? null,
    openingBalance: opening,
    openingText: breakdown(opening, product.units),
    closingBalance: balance,
    closingText: breakdown(balance, product.units),
    truncated,
    movements: lines,
  };
}

/** Active products with a reorder level set whose stock is at or below it. */
export async function low(actor, godownId) {
  const rows = await prisma.$queryRaw`
    SELECT p.id, p.reorder_level, COALESCE(SUM(m.quantity), 0) AS qty
    FROM products p
    LEFT JOIN stock_movements m
      ON m.product_id = p.id AND m.tenant_id = p.tenant_id
      ${godownId ? Prisma.sql`AND m.godown_id = ${godownId}` : Prisma.empty}
    WHERE p.tenant_id = ${actor.tenantId} AND p.is_active AND p.reorder_level > 0
    GROUP BY p.id
    HAVING COALESCE(SUM(m.quantity), 0) <= p.reorder_level
    ORDER BY COALESCE(SUM(m.quantity), 0) / p.reorder_level, p.id`;
  if (!rows.length) return [];

  const products = await prisma.product.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    include: { units: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  return rows.map((r) => {
    const p = byId.get(r.id);
    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      baseUnit: p.baseUnit,
      baseQty: r.qty,
      text: breakdown(r.qty, p.units),
      reorderLevel: r.reorder_level,
      reorderText: breakdown(r.reorder_level, p.units),
      shortBy: r.reorder_level.minus(r.qty),
    };
  });
}

/** Batches in stock that expire within `days` (already-expired ones are included and flagged). */
export async function expiring(actor, q) {
  const today = nepalToday();
  const until = addDays(today, q.days).toISOString().slice(0, 10);
  const rows = await prisma.$queryRaw`
    SELECT b.id AS batch_id, b.batch_no, b.expiry_date, m.product_id,
           m.godown_id, g.name AS godown_name, SUM(m.quantity) AS qty
    FROM stock_movements m
    JOIN batches b ON b.id = m.batch_id
    JOIN godowns g ON g.id = m.godown_id
    WHERE m.tenant_id = ${actor.tenantId}
      AND b.expiry_date IS NOT NULL
      AND b.expiry_date <= ${until}::date
      ${q.godownId ? Prisma.sql`AND m.godown_id = ${q.godownId}` : Prisma.empty}
    GROUP BY b.id, b.batch_no, b.expiry_date, m.product_id, m.godown_id, g.name
    HAVING SUM(m.quantity) > 0
    ORDER BY b.expiry_date, b.batch_no`;
  if (!rows.length) return { today: nepalTodayString(), days: q.days, items: [] };

  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.product_id))] } },
    include: { units: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const DAY = 24 * 60 * 60 * 1000;
  return {
    today: nepalTodayString(),
    days: q.days,
    items: rows.map((r) => {
      const p = byId.get(r.product_id);
      const daysLeft = Math.round((r.expiry_date.getTime() - today.getTime()) / DAY);
      return {
        batchId: r.batch_id,
        batchNo: r.batch_no,
        expiryDate: r.expiry_date.toISOString().slice(0, 10),
        daysLeft,
        expired: daysLeft < 0,
        product: { id: p.id, sku: p.sku, name: p.name },
        godown: { id: r.godown_id, name: r.godown_name },
        baseQty: r.qty,
        text: breakdown(r.qty, p.units),
      };
    }),
  };
}

/** Stock value per godown: Σ product qty × weighted average purchase cost. */
export async function valuation(actor) {
  const rows = await prisma.$queryRaw`
    WITH ${avgCostCte(actor.tenantId)},
    stock AS (
      SELECT godown_id, product_id, SUM(quantity) AS qty
      FROM stock_movements
      WHERE tenant_id = ${actor.tenantId}
      GROUP BY godown_id, product_id
    )
    SELECT g.id AS godown_id, g.name AS godown_name, g.is_active,
           SUM(s.qty * COALESCE(c.avg_cost, 0)) AS value,
           COUNT(s.product_id) FILTER (WHERE s.qty <> 0) AS products
    FROM godowns g
    LEFT JOIN stock s ON s.godown_id = g.id
    LEFT JOIN cost c ON c.product_id = s.product_id
    WHERE g.tenant_id = ${actor.tenantId}
    GROUP BY g.id, g.name, g.is_active
    ORDER BY g.name`;

  const godowns = rows.map((r) => ({
    godownId: r.godown_id,
    godownName: r.godown_name,
    isActive: r.is_active,
    productsInStock: Number(r.products),
    value: round2(r.value ?? new Decimal(0)),
  }));
  return {
    method: 'Weighted average cost of OPENING + PURCHASE movements, excluding VAT',
    godowns,
    total: godowns.reduce((s, g) => s.plus(g.value), new Decimal(0)),
  };
}
