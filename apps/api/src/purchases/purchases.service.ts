import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { calculateBill } from '../common/billing/bill-totals.js';
import { dateOnly, nepalToday } from '../common/dates.js';
import { pageArgs } from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  AuditAction,
  LedgerEntryType,
  MovementType,
  PartyType,
  Prisma,
  PurchaseStatus,
} from '../generated/prisma/client.js';
import { GodownsService } from '../godowns/godowns.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { baseQuantity, loadProducts } from '../stock/stock-lines.js';
import {
  InsufficientStockException,
  StockService,
} from '../stock/stock.service.js';

import type {
  CreatePurchaseDto,
  ListPurchasesQueryDto,
} from './purchases.dto.js';

const { Decimal } = Prisma;
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
} satisfies Prisma.PurchaseInclude;

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly ledger: LedgerService,
    private readonly godowns: GodownsService,
  ) {}

  async list(actor: AuthUser, q: ListPurchasesQueryDto) {
    const where: Prisma.PurchaseWhereInput = {
      tenantId: actor.tenantId,
      supplierId: q.supplierId,
      status: q.status,
      ...((q.from || q.to) && {
        purchaseDate: {
          ...(q.from && { gte: dateOnly(q.from) }),
          ...(q.to && { lte: dateOnly(q.to) }),
        },
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          godown: { select: { id: true, name: true } },
        },
        orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.purchase.count({ where }),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async findOne(actor: AuthUser, id: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: DETAIL_INCLUDE,
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    return purchase;
  }

  /**
   * Records a supplier bill. In ONE transaction: batches, purchase + items,
   * PURCHASE stock movements, a CREDIT ledger entry for the supplier, audit.
   */
  async create(actor: AuthUser, dto: CreatePurchaseDto) {
    const supplier = await this.prisma.party.findFirst({
      where: { id: dto.supplierId, tenantId: actor.tenantId },
    });
    if (!supplier) throw new BadRequestException('Supplier not found');
    if (supplier.type === PartyType.CUSTOMER) {
      throw new BadRequestException(`${supplier.name} is not a supplier`);
    }
    if (!supplier.isActive) {
      throw new BadRequestException(`Supplier ${supplier.name} is inactive`);
    }
    const godown = await this.godowns.getActive(actor, dto.godownId);
    await this.assertNewBill(actor.tenantId, supplier.id, dto.supplierBillNo);

    const products = await loadProducts(
      this.prisma,
      actor.tenantId,
      dto.items.map((i) => i.productId),
    );
    const lines = dto.items.map((item, i) => {
      const product = products.get(item.productId)!;
      if (!product.isActive) {
        throw new BadRequestException(
          `Item ${i + 1}: ${product.name} is inactive`,
        );
      }
      if (product.trackBatch && !item.batchNo) {
        throw new BadRequestException(
          `Item ${i + 1}: batchNo is required for ${product.name} (batch-tracked)`,
        );
      }
      if (!product.trackBatch && (item.batchNo || item.expiryDate)) {
        throw new BadRequestException(
          `Item ${i + 1}: ${product.name} is not batch-tracked; remove batchNo/expiryDate`,
        );
      }
      return {
        item,
        product,
        baseQty: baseQuantity(product, item.unitId, item.quantity),
      };
    });

    let totals: ReturnType<typeof calculateBill>;
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
      if (e instanceof RangeError) throw new BadRequestException(e.message);
      throw e;
    }

    try {
      const purchase = await this.prisma.$transaction(
        async (tx) => {
          const rows = [];
          for (const [i, { item, product, baseQty }] of lines.entries()) {
            // Cost per BASE unit excludes VAT (it is claimed back as input credit).
            const unitCost = totals.lines[i].taxable
              .div(baseQty)
              .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
            const batchId = product.trackBatch
              ? await this.findOrCreateBatch(
                  tx,
                  actor.tenantId,
                  product,
                  item,
                  unitCost,
                )
              : null;
            rows.push({
              item,
              product,
              baseQty,
              unitCost,
              batchId,
              t: totals.lines[i],
            });
          }

          const purchase = await tx.purchase.create({
            data: {
              tenantId: actor.tenantId,
              supplierId: supplier.id,
              godownId: godown.id,
              supplierBillNo: dto.supplierBillNo,
              purchaseDate: dateOnly(dto.purchaseDate),
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

          await this.stock.postMovements(
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
              refId: purchase.id,
              createdById: actor.userId,
            })),
          );

          // We now owe the supplier the bill total.
          await this.ledger.post(tx, {
            tenantId: actor.tenantId,
            partyId: supplier.id,
            entryDate: purchase.purchaseDate,
            type: LedgerEntryType.PURCHASE,
            credit: totals.total,
            refType: PURCHASE_REF,
            refId: purchase.id,
            narration: `Purchase bill ${dto.supplierBillNo}`,
          });

          await this.audit.log(
            {
              tenantId: actor.tenantId,
              userId: actor.userId,
              entity: 'Purchase',
              entityId: purchase.id,
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
          return purchase;
        },
        { timeout: 30_000 },
      );
      return this.findOne(actor, purchase.id);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          `Bill ${dto.supplierBillNo} from this supplier is already entered`,
        );
      }
      throw e;
    }
  }

  /**
   * Cancels a purchase: reverses its stock and posts an opposite (DEBIT) ledger
   * entry, in one transaction. Fails if the stock has already been sold or moved.
   */
  async cancel(actor: AuthUser, id: string, reason: string) {
    const purchase = await this.findOne(actor, id);
    if (purchase.status === PurchaseStatus.CANCELLED) {
      throw new ConflictException('This purchase is already cancelled');
    }

    try {
      await this.prisma.$transaction(
        async (tx) => {
          // Conditional update: a concurrent cancel can't also succeed.
          const { count } = await tx.purchase.updateMany({
            where: {
              id,
              tenantId: actor.tenantId,
              status: PurchaseStatus.POSTED,
            },
            data: {
              status: PurchaseStatus.CANCELLED,
              cancelReason: reason,
              cancelledAt: new Date(),
              cancelledById: actor.userId,
            },
          });
          if (count === 0) {
            throw new ConflictException('This purchase is already cancelled');
          }

          await this.stock.reverseMovements(
            tx,
            actor.tenantId,
            PURCHASE_REF,
            id,
            actor.userId,
          );
          await this.ledger.post(tx, {
            tenantId: actor.tenantId,
            partyId: purchase.supplierId,
            entryDate: nepalToday(),
            type: LedgerEntryType.PURCHASE,
            debit: purchase.total,
            refType: PURCHASE_REF,
            refId: id,
            narration: `Purchase bill ${purchase.supplierBillNo} cancelled: ${reason}`,
          });
          await this.audit.log(
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
      if (e instanceof InsufficientStockException) {
        throw new ConflictException(
          `Cannot cancel this purchase: some of its stock has already been sold or moved. ${e.message}`,
        );
      }
      throw e;
    }
    return this.findOne(actor, id);
  }

  private async assertNewBill(
    tenantId: string,
    supplierId: string,
    billNo: string,
  ) {
    const existing = await this.prisma.purchase.findFirst({
      where: { tenantId, supplierId, supplierBillNo: billNo },
      select: { status: true },
    });
    if (existing) {
      throw new ConflictException(
        `Bill ${billNo} from this supplier is already entered` +
          (existing.status === PurchaseStatus.CANCELLED
            ? ' (it was cancelled; cancelled bill numbers cannot be reused)'
            : ''),
      );
    }
  }

  private async findOrCreateBatch(
    tx: Prisma.TransactionClient,
    tenantId: string,
    product: { id: string; name: string },
    item: CreatePurchaseDto['items'][number],
    unitCost: Prisma.Decimal,
  ) {
    const existing = await tx.batch.findUnique({
      where: {
        productId_batchNo: { productId: product.id, batchNo: item.batchNo! },
      },
    });
    if (existing) {
      const given = item.expiryDate
        ? dateOnly(item.expiryDate).getTime()
        : null;
      if (given !== null && existing.expiryDate?.getTime() !== given) {
        throw new BadRequestException(
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
        batchNo: item.batchNo!,
        expiryDate: item.expiryDate ? dateOnly(item.expiryDate) : null,
        mfgDate: item.mfgDate ? dateOnly(item.mfgDate) : null,
        costPrice: unitCost,
      },
    });
    return batch.id;
  }
}
