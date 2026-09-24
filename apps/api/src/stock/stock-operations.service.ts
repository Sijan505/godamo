import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { pageArgs } from '../common/pagination.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { fromBase } from '../common/units/unit-conversion.js';
import {
  AuditAction,
  MovementType,
  Prisma,
  StockCountStatus,
} from '../generated/prisma/client.js';
import { GodownsService } from '../godowns/godowns.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertBatch,
  baseQuantity,
  loadProducts,
  type ProductWithUnits,
} from './stock-lines.js';
import type {
  CreateAdjustmentDto,
  CreateCountDto,
  CreateTransferDto,
  ListCountsQueryDto,
} from './stock.dto.js';
import { type BatchAllocation, StockService } from './stock.service.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;
const TX_OPTIONS = { timeout: 30_000 };

export const TRANSFER_REF = 'TRANSFER';
export const ADJUSTMENT_REF = 'ADJUSTMENT';
export const STOCK_COUNT_REF = 'STOCK_COUNT';

@Injectable()
export class StockOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly godowns: GodownsService,
  ) {}

  // ─── Transfers ─────────────────────────────────────────────────────────────

  /** TRANSFER_OUT + TRANSFER_IN pairs in one transaction, sharing one refId. */
  async transfer(actor: AuthUser, dto: CreateTransferDto) {
    if (dto.fromGodownId === dto.toGodownId) {
      throw new BadRequestException('From and to godown must be different');
    }
    const from = await this.godowns.getActive(
      actor,
      dto.fromGodownId,
      'From godown',
    );
    const to = await this.godowns.getActive(actor, dto.toGodownId, 'To godown');
    const products = await loadProducts(
      this.prisma,
      actor.tenantId,
      dto.items.map((i) => i.productId),
    );
    const lines = dto.items.map((item) => {
      const product = products.get(item.productId)!;
      this.assertBatchUsage(product, item.batchId);
      return {
        item,
        product,
        baseQty: baseQuantity(product, item.unitId, item.quantity),
      };
    });

    const transfer = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockTransfer.create({
        data: {
          tenantId: actor.tenantId,
          fromGodownId: from.id,
          toGodownId: to.id,
          note: dto.note,
          createdById: actor.userId,
        },
      });
      const costs = await this.stock.averageCosts(tx, actor.tenantId, [
        ...products.keys(),
      ]);

      // Line by line, so a later line's FEFO pick sees earlier lines' stock-outs.
      for (const { item, product, baseQty } of lines) {
        const picks = await this.pickBatches(
          tx,
          actor,
          from.id,
          product,
          baseQty,
          item.batchId,
        );
        const unitCost = costs.get(product.id) ?? new Decimal(0);
        const common = {
          tenantId: actor.tenantId,
          productId: product.id,
          unitCost,
          refType: TRANSFER_REF,
          refId: doc.id,
          createdById: actor.userId,
        };
        await this.stock.postMovements(
          tx,
          picks.flatMap((p) => [
            {
              ...common,
              godownId: from.id,
              batchId: p.batchId,
              type: MovementType.TRANSFER_OUT,
              quantity: p.qty.neg(),
            },
            {
              ...common,
              godownId: to.id,
              batchId: p.batchId,
              type: MovementType.TRANSFER_IN,
              quantity: p.qty,
            },
          ]),
        );
      }

      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'StockTransfer',
          entityId: doc.id,
          action: AuditAction.CREATE,
          newValue: { ...dto, fromGodown: from.name, toGodown: to.name },
        },
        tx,
      );
      return doc;
    }, TX_OPTIONS);

    return this.documentWithMovements(
      actor,
      TRANSFER_REF,
      transfer.id,
      transfer,
    );
  }

  // ─── Adjustments ───────────────────────────────────────────────────────────

  async adjust(actor: AuthUser, dto: CreateAdjustmentDto) {
    const godown = await this.godowns.getActive(actor, dto.godownId);
    const products = await loadProducts(
      this.prisma,
      actor.tenantId,
      dto.items.map((i) => i.productId),
    );
    const lines = dto.items.map((item, i) => {
      const product = products.get(item.productId)!;
      if (dto.type === MovementType.DAMAGE && item.quantity > 0) {
        throw new BadRequestException(
          `Item ${i + 1}: DAMAGE quantities must be negative (stock going out)`,
        );
      }
      this.assertBatchUsage(product, item.batchId);
      if (product.trackBatch && item.quantity > 0 && !item.batchId) {
        throw new BadRequestException(
          `Item ${i + 1}: batchId is required to add stock of ${product.name} (batch-tracked)`,
        );
      }
      const baseQty = baseQuantity(
        product,
        item.unitId,
        Math.abs(item.quantity),
      );
      return { item, product, baseQty, out: item.quantity < 0 };
    });

    const adjustment = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockAdjustment.create({
        data: {
          tenantId: actor.tenantId,
          godownId: godown.id,
          type: dto.type,
          reason: dto.reason,
          createdById: actor.userId,
        },
      });
      const costs = await this.stock.averageCosts(tx, actor.tenantId, [
        ...products.keys(),
      ]);

      for (const { item, product, baseQty, out } of lines) {
        const picks = out
          ? await this.pickBatches(
              tx,
              actor,
              godown.id,
              product,
              baseQty,
              item.batchId,
            )
          : [{ batchId: item.batchId ?? null, qty: baseQty }];
        await this.stock.postMovements(
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
            refId: doc.id,
            createdById: actor.userId,
          })),
        );
      }

      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'StockAdjustment',
          entityId: doc.id,
          action: AuditAction.CREATE,
          newValue: { ...dto, godown: godown.name },
        },
        tx,
      );
      return doc;
    }, TX_OPTIONS);

    return this.documentWithMovements(
      actor,
      ADJUSTMENT_REF,
      adjustment.id,
      adjustment,
    );
  }

  // ─── Counts ────────────────────────────────────────────────────────────────

  /** Records a physical count and freezes the differences against system stock. */
  async createCount(actor: AuthUser, dto: CreateCountDto) {
    const godown = await this.godowns.getActive(actor, dto.godownId);
    const products = await loadProducts(
      this.prisma,
      actor.tenantId,
      dto.items.map((i) => i.productId),
    );
    const seen = new Set<string>();
    const rows: Prisma.StockCountItemUncheckedCreateWithoutCountInput[] = [];
    for (const [i, item] of dto.items.entries()) {
      const product = products.get(item.productId)!;
      this.assertBatchUsage(product, item.batchId);
      if (product.trackBatch && !item.batchId) {
        throw new BadRequestException(
          `Item ${i + 1}: count ${product.name} per batch (batchId is required)`,
        );
      }
      if (item.batchId) {
        await assertBatch(this.prisma, actor.tenantId, product, item.batchId);
      }
      const key = `${product.id}:${item.batchId ?? ''}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          `Item ${i + 1}: ${product.name} is listed twice`,
        );
      }
      seen.add(key);

      const countedBaseQty = baseQuantity(
        product,
        item.unitId,
        item.countedQty,
      );
      const systemBaseQty = await this.stock.getBalance(
        this.prisma,
        actor.tenantId,
        godown.id,
        product.id,
        item.batchId,
      );
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

    const count = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stockCount.create({
        data: {
          tenantId: actor.tenantId,
          godownId: godown.id,
          note: dto.note,
          createdById: actor.userId,
          items: { create: rows },
        },
      });
      await this.audit.log(
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
    return this.findCount(actor, count.id);
  }

  async listCounts(actor: AuthUser, q: ListCountsQueryDto) {
    const where: Prisma.StockCountWhereInput = {
      tenantId: actor.tenantId,
      godownId: q.godownId,
      status: q.status,
    };
    const [items, total] = await Promise.all([
      this.prisma.stockCount.findMany({
        where,
        include: {
          godown: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.stockCount.count({ where }),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  /** A count with each line's system / counted / difference, also as unit breakdowns. */
  async findCount(actor: AuthUser, id: string) {
    const count = await this.prisma.stockCount.findFirst({
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
    if (!count) throw new NotFoundException('Stock count not found');

    const { items, ...header } = count;
    return {
      ...header,
      items: items.map(({ product, ...item }) => {
        const text = (q: Prisma.Decimal) =>
          (q.lt(0) ? '-' : '') + fromBase(q.abs(), product.units).text;
        return {
          ...item,
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            baseUnit: product.baseUnit,
          },
          systemText: text(item.systemBaseQty),
          countedText: text(item.countedBaseQty),
          differenceText: item.differenceBaseQty.isZero()
            ? 'no difference'
            : (item.differenceBaseQty.gt(0) ? '+' : '') +
              text(item.differenceBaseQty),
        };
      }),
    };
  }

  /** Posts ADJUSTMENT movements for every non-zero difference of a pending count. */
  async applyCount(actor: AuthUser, id: string) {
    const count = await this.prisma.stockCount.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: { items: true },
    });
    if (!count) throw new NotFoundException('Stock count not found');
    if (count.status === StockCountStatus.APPLIED) {
      throw new ConflictException('This stock count has already been applied');
    }

    await this.prisma.$transaction(async (tx) => {
      const { count: updated } = await tx.stockCount.updateMany({
        where: { id, status: StockCountStatus.PENDING },
        data: {
          status: StockCountStatus.APPLIED,
          appliedById: actor.userId,
          appliedAt: new Date(),
        },
      });
      if (!updated) {
        throw new ConflictException(
          'This stock count has already been applied',
        );
      }

      const diffs = count.items.filter((i) => !i.differenceBaseQty.isZero());
      const costs = await this.stock.averageCosts(
        tx,
        actor.tenantId,
        diffs.map((d) => d.productId),
      );
      await this.stock.postMovements(
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
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'StockCount',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: { status: StockCountStatus.PENDING },
          newValue: {
            status: StockCountStatus.APPLIED,
            adjustedLines: diffs.length,
          },
        },
        tx,
      );
    }, TX_OPTIONS);
    return this.findCount(actor, id);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private assertBatchUsage(product: ProductWithUnits, batchId?: string) {
    if (batchId && !product.trackBatch) {
      throw new BadRequestException(
        `${product.name} is not batch-tracked; remove batchId`,
      );
    }
  }

  /** Batches to take `baseQty` from: the given batch, or FEFO for tracked products. */
  private async pickBatches(
    tx: Tx,
    actor: AuthUser,
    godownId: string,
    product: ProductWithUnits,
    baseQty: Prisma.Decimal,
    batchId?: string,
  ): Promise<{ batchId: string | null; qty: Prisma.Decimal }[]> {
    if (!product.trackBatch) return [{ batchId: null, qty: baseQty }];
    if (batchId) {
      await assertBatch(tx, actor.tenantId, product, batchId);
      return [{ batchId, qty: baseQty }];
    }
    const picks: BatchAllocation[] = await this.stock.allocateFEFO(
      tx,
      actor.tenantId,
      godownId,
      product.id,
      baseQty,
    );
    return picks;
  }

  private async documentWithMovements<T extends object>(
    actor: AuthUser,
    refType: string,
    refId: string,
    doc: T,
  ) {
    const movements = await this.prisma.stockMovement.findMany({
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
}
