import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { nepalToday } from '../common/dates.js';
import { fromBase } from '../common/units/unit-conversion.js';
import { MovementType, Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;
type Tx = Prisma.TransactionClient;

export interface MovementInput {
  tenantId: string;
  godownId: string;
  productId: string;
  batchId?: string | null;
  type: MovementType;
  /** BASE units. Positive = stock in, negative = stock out. */
  quantity: Decimal;
  /** Cost per BASE unit. */
  unitCost?: Decimal;
  refType: string;
  refId: string;
  createdById: string;
  reversalOfId?: string;
  clientUuid?: string;
}

export interface BatchAllocation {
  batchId: string;
  qty: Decimal;
}

/** Thrown when a movement would take stock below zero. HTTP 409. */
export class InsufficientStockException extends ConflictException {}

/**
 * The stock engine. This is the ONLY code allowed to create StockMovement rows.
 * Stock is never stored; a balance is always SUM(quantity) over movements.
 *
 * Every write method takes the caller's transaction, so the stock change commits
 * or rolls back together with the document (purchase, invoice…) that caused it.
 */
@Injectable()
export class StockService {
  /**
   * Validates and writes movements. For every godown + product (+ batch for
   * batch-tracked products) whose net change is negative, it takes an advisory
   * lock and refuses to go below zero.
   */
  async postMovements(tx: Tx, movements: MovementInput[]) {
    if (!movements.length) return [];
    const tenantId = movements[0].tenantId;
    if (movements.some((m) => m.tenantId !== tenantId)) {
      throw new BadRequestException('All movements must belong to one tenant');
    }
    if (movements.some((m) => m.quantity.isZero())) {
      throw new BadRequestException('A stock movement quantity cannot be 0');
    }

    const [products, godowns] = await Promise.all([
      tx.product.findMany({
        where: {
          id: { in: unique(movements.map((m) => m.productId)) },
          tenantId,
        },
        include: { units: true },
      }),
      tx.godown.findMany({
        where: {
          id: { in: unique(movements.map((m) => m.godownId)) },
          tenantId,
        },
      }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const godownById = new Map(godowns.map((g) => [g.id, g]));

    // Net change per balance key. Batch-tracked products balance per batch.
    const net = new Map<
      string,
      {
        godownId: string;
        productId: string;
        batchId: string | null;
        change: Decimal;
      }
    >();
    for (const m of movements) {
      const product = productById.get(m.productId);
      if (!product) throw new BadRequestException('Product not found');
      if (!godownById.has(m.godownId)) {
        throw new BadRequestException('Godown not found');
      }
      if (product.trackBatch && !m.batchId) {
        throw new BadRequestException(
          `A batch is required for ${product.name} (batch-tracked product)`,
        );
      }
      const batchId = product.trackBatch ? m.batchId! : null;
      const key = `${m.godownId}|${m.productId}|${batchId ?? ''}`;
      const entry = net.get(key) ?? {
        godownId: m.godownId,
        productId: m.productId,
        batchId,
        change: new Decimal(0),
      };
      entry.change = entry.change.plus(m.quantity);
      net.set(key, entry);
    }

    const outs = [...net.values()].filter((n) => n.change.lt(0));
    await this.lock(tx, tenantId, outs);

    for (const out of outs) {
      const available = await this.getBalance(
        tx,
        tenantId,
        out.godownId,
        out.productId,
        out.batchId ?? undefined,
      );
      if (available.plus(out.change).lt(0)) {
        const batch = out.batchId
          ? await tx.batch.findMany({ where: { id: { in: [out.batchId] } } })
          : [];
        throw this.insufficient(
          productById.get(out.productId)!,
          godownById.get(out.godownId)!.name,
          available,
          batch[0]?.batchNo,
        );
      }
    }

    return tx.stockMovement.createManyAndReturn({
      data: movements.map((m) => ({
        tenantId: m.tenantId,
        godownId: m.godownId,
        productId: m.productId,
        batchId: m.batchId ?? null,
        type: m.type,
        quantity: m.quantity,
        unitCost: m.unitCost ?? new Decimal(0),
        refType: m.refType,
        refId: m.refId,
        createdById: m.createdById,
        reversalOfId: m.reversalOfId,
        clientUuid: m.clientUuid,
      })),
    });
  }

  /**
   * Picks batches for an OUT of `baseQty`: earliest expiry first, batches
   * without expiry last, expired batches skipped. Throws if there isn't enough.
   */
  async allocateFEFO(
    tx: Tx,
    tenantId: string,
    godownId: string,
    productId: string,
    baseQty: Decimal,
    today: Date = nepalToday(),
  ): Promise<BatchAllocation[]> {
    await this.lock(tx, tenantId, [{ godownId, productId }]);

    const balances = await tx.stockMovement.groupBy({
      by: ['batchId'],
      where: { tenantId, godownId, productId, batchId: { not: null } },
      _sum: { quantity: true },
    });
    const inStock = balances.filter((b) => b._sum.quantity?.gt(0));
    const batches = await tx.batch.findMany({
      where: { id: { in: inStock.map((b) => b.batchId!) } },
    });
    const qtyByBatch = new Map(
      inStock.map((b) => [b.batchId!, b._sum.quantity!]),
    );

    const usable = batches
      .filter((b) => !b.expiryDate || b.expiryDate >= today)
      .sort(
        (a, b) =>
          (a.expiryDate?.getTime() ?? Infinity) -
            (b.expiryDate?.getTime() ?? Infinity) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );

    const allocations: BatchAllocation[] = [];
    let remaining = new Decimal(baseQty);
    for (const batch of usable) {
      if (remaining.lte(0)) break;
      const take = Decimal.min(remaining, qtyByBatch.get(batch.id)!);
      allocations.push({ batchId: batch.id, qty: take });
      remaining = remaining.minus(take);
    }

    if (remaining.gt(0)) {
      const available = usable.reduce(
        (sum, b) => sum.plus(qtyByBatch.get(b.id)!),
        new Decimal(0),
      );
      const [product, godown] = await Promise.all([
        tx.product.findMany({
          where: { id: { in: [productId] }, tenantId },
          include: { units: true },
        }),
        tx.godown.findMany({ where: { id: { in: [godownId] }, tenantId } }),
      ]);
      const skippedExpired = usable.length < batches.length;
      throw this.insufficient(
        product[0],
        godown[0]?.name ?? 'godown',
        available,
        undefined,
        skippedExpired ? ' (expired batches excluded)' : '',
      );
    }
    return allocations;
  }

  /**
   * Undoes every not-yet-reversed movement of a document by posting opposite
   * rows with reversalOfId set. Old rows are never edited or deleted. Throws
   * InsufficientStockException if the stock has since been used.
   */
  async reverseMovements(
    tx: Tx,
    tenantId: string,
    refType: string,
    refId: string,
    createdById: string,
  ) {
    const originals = await tx.stockMovement.findMany({
      where: {
        tenantId,
        refType,
        refId,
        reversalOfId: null,
        reversedBy: { is: null },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return this.postMovements(
      tx,
      originals.map((o) => ({
        tenantId,
        godownId: o.godownId,
        productId: o.productId,
        batchId: o.batchId,
        type: o.type,
        quantity: o.quantity.neg(),
        unitCost: o.unitCost,
        refType,
        refId,
        createdById,
        reversalOfId: o.id,
      })),
    );
  }

  /** Current stock in BASE units. Pass batchId to get one batch's balance. */
  async getBalance(
    db: Tx,
    tenantId: string,
    godownId: string,
    productId: string,
    batchId?: string,
  ): Promise<Decimal> {
    const result = await db.stockMovement.aggregate({
      where: {
        tenantId,
        godownId,
        productId,
        ...(batchId !== undefined && { batchId }),
      },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? new Decimal(0);
  }

  /**
   * Weighted average cost per BASE unit from OPENING and PURCHASE movements
   * (cancelled purchases cancel themselves out through their reversal rows).
   */
  async averageCosts(
    db: Tx,
    tenantId: string,
    productIds: string[],
  ): Promise<Map<string, Decimal>> {
    if (!productIds.length) return new Map();
    const rows = await db.$queryRaw<
      { product_id: string; avg_cost: Decimal | null }[]
    >`
      SELECT product_id,
             SUM(quantity * unit_cost) / NULLIF(SUM(quantity), 0) AS avg_cost
      FROM stock_movements
      WHERE tenant_id = ${tenantId}
        AND product_id = ANY(${productIds}::text[])
        AND type IN ('OPENING', 'PURCHASE')
      GROUP BY product_id`;
    return new Map(
      rows.map((r) => [
        r.product_id,
        (r.avg_cost ?? new Decimal(0)).toDecimalPlaces(
          4,
          Decimal.ROUND_HALF_UP,
        ),
      ]),
    );
  }

  // Transaction-scoped advisory locks, one per godown + product, taken in a
  // fixed order so two transactions can't deadlock each other.
  private async lock(
    tx: Tx,
    tenantId: string,
    keys: { godownId: string; productId: string }[],
  ) {
    const lockKeys = unique(
      keys.map((k) => `stock:${tenantId}:${k.godownId}:${k.productId}`),
    ).sort();
    for (const key of lockKeys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
  }

  private insufficient(
    product: { name: string; units: { name: string; factor: Decimal }[] },
    godownName: string,
    available: Decimal,
    batchNo?: string,
    suffix = '',
  ) {
    const what = batchNo ? `${product.name} (batch ${batchNo})` : product.name;
    const breakdown = fromBase(Decimal.max(available, 0), product.units).text;
    return new InsufficientStockException(
      `Not enough stock: ${what} in ${godownName}, available ${breakdown}${suffix}`,
    );
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
