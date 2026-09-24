import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { dateOnly, nepalToday } from '../common/dates.js';
import { getFiscalYear } from '../common/nepali-date/nepali-date.js';
import { nextSalesOrderNo } from '../common/numbering/numbering.js';
import { pageArgs } from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { fromBase } from '../common/units/unit-conversion.js';
import {
  AuditAction,
  OrderStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import { GodownsService } from '../godowns/godowns.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type PricedSale,
  SaleLinesService,
} from '../sales/sale-lines.service.js';
import { StockService } from '../stock/stock.service.js';
import type {
  CreateSalesOrderDto,
  ListSalesOrdersQueryDto,
  UpdateSalesOrderDto,
} from './sales-orders.dto.js';

const { Decimal } = Prisma;

const DETAIL_INCLUDE = {
  party: { select: { id: true, name: true, phone: true } },
  salesman: { select: { id: true, name: true } },
  godown: { select: { id: true, name: true } },
  items: {
    include: {
      product: { select: { id: true, sku: true, name: true } },
      unit: { select: { id: true, name: true } },
    },
  },
  invoices: {
    select: { id: true, fiscalYear: true, invoiceNo: true, status: true },
  },
} satisfies Prisma.SalesOrderInclude;

export interface StockWarning {
  productId: string;
  productName: string;
  requested: string;
  available: string;
  message: string;
}

@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly lines: SaleLinesService,
    private readonly stock: StockService,
    private readonly godowns: GodownsService,
  ) {}

  /** Salesmen only ever see their own orders; everyone else sees all. */
  private scope(actor: AuthUser): Prisma.SalesOrderWhereInput {
    return {
      tenantId: actor.tenantId,
      ...(actor.role === UserRole.SALESMAN && { salesmanId: actor.userId }),
    };
  }

  async list(actor: AuthUser, q: ListSalesOrdersQueryDto) {
    const where: Prisma.SalesOrderWhereInput = {
      ...(q.salesmanId && { salesmanId: q.salesmanId }),
      ...this.scope(actor),
      status: q.status,
      partyId: q.partyId,
      ...((q.from || q.to) && {
        orderDate: {
          ...(q.from && { gte: dateOnly(q.from) }),
          ...(q.to && { lte: dateOnly(q.to) }),
        },
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.salesOrder.findMany({
        where,
        include: {
          party: { select: { id: true, name: true } },
          salesman: { select: { id: true, name: true } },
          godown: { select: { id: true, name: true } },
        },
        orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.salesOrder.count({ where }),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async findOne(actor: AuthUser, id: string) {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id, ...this.scope(actor) },
      include: DETAIL_INCLUDE,
    });
    if (!order) throw new NotFoundException('Sales order not found');
    return order;
  }

  /**
   * Creates a DRAFT order priced by the server. With a clientUuid that was
   * already used, returns that order instead (safe to retry from the field app).
   */
  async create(actor: AuthUser, dto: CreateSalesOrderDto) {
    if (dto.clientUuid) {
      const existing = await this.findByClientUuid(actor, dto.clientUuid);
      if (existing) return existing;
    }

    const party = await this.lines.getCustomer(actor, dto.partyId);
    const godown = await this.godowns.getActive(actor, dto.godownId);
    const salesmanId = await this.resolveSalesman(actor, dto.salesmanId);
    const priced = await this.lines.price(actor, party.id, dto.items);
    const stockWarnings = await this.stockWarnings(actor, godown.id, priced);

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const orderNo = await nextSalesOrderNo(
          tx,
          actor.tenantId,
          getFiscalYear(new Date()),
        );
        const created = await tx.salesOrder.create({
          data: {
            tenantId: actor.tenantId,
            orderNo,
            partyId: party.id,
            salesmanId,
            godownId: godown.id,
            orderDate: nepalToday(),
            notes: dto.notes,
            clientUuid: dto.clientUuid,
            ...this.totalsData(priced),
            items: { create: this.itemsData(actor, priced) },
          },
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'SalesOrder',
            entityId: created.id,
            action: AuditAction.CREATE,
            newValue: {
              orderNo,
              partyId: party.id,
              total: priced.totals.total,
              items: dto.items,
            },
          },
          tx,
        );
        return created;
      });
      return { ...(await this.findOne(actor, order.id)), stockWarnings };
    } catch (e) {
      // Two retries of the same offline order racing each other: one wins.
      if (dto.clientUuid && isUniqueViolation(e)) {
        const existing = await this.findByClientUuid(actor, dto.clientUuid);
        if (existing) return existing;
      }
      throw e;
    }
  }

  /** Edits a DRAFT order; items (if given) replace the old ones and are re-priced. */
  async update(actor: AuthUser, id: string, dto: UpdateSalesOrderDto) {
    const before = await this.findOne(actor, id);
    if (before.status !== OrderStatus.DRAFT) {
      throw new ConflictException(
        `Only DRAFT orders can be edited (this one is ${before.status})`,
      );
    }
    const godownId = dto.godownId
      ? (await this.godowns.getActive(actor, dto.godownId)).id
      : before.godownId;
    const priced = dto.items
      ? await this.lines.price(actor, before.partyId, dto.items)
      : null;
    const stockWarnings = priced
      ? await this.stockWarnings(actor, godownId, priced)
      : [];

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesOrder.updateMany({
        where: { id, status: OrderStatus.DRAFT },
        data: {
          godownId,
          notes: dto.notes,
          ...(priced && this.totalsData(priced)),
        },
      });
      if (!count)
        throw new ConflictException('Only DRAFT orders can be edited');
      if (priced) {
        await tx.salesOrderItem.deleteMany({ where: { orderId: id } });
        await tx.salesOrderItem.createMany({
          data: this.itemsData(actor, priced).map((i) => ({
            ...i,
            orderId: id,
          })),
        });
      }
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'SalesOrder',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: {
            godownId: before.godownId,
            notes: before.notes,
            total: before.total,
            items: before.items.map((i) => ({
              productId: i.productId,
              unitId: i.unitId,
              quantity: i.quantity,
              discountPercent: i.discountPercent,
            })),
          },
          newValue: {
            godownId,
            notes: dto.notes,
            total: priced?.totals.total,
            items: dto.items,
          },
        },
        tx,
      );
    });
    return { ...(await this.findOne(actor, id)), stockWarnings };
  }

  confirm(actor: AuthUser, id: string) {
    return this.changeStatus(
      actor,
      id,
      [OrderStatus.DRAFT],
      OrderStatus.CONFIRMED,
    );
  }

  cancel(actor: AuthUser, id: string, reason: string) {
    return this.changeStatus(
      actor,
      id,
      [OrderStatus.DRAFT, OrderStatus.CONFIRMED],
      OrderStatus.CANCELLED,
      reason,
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async changeStatus(
    actor: AuthUser,
    id: string,
    from: OrderStatus[],
    to: OrderStatus,
    reason?: string,
  ) {
    const order = await this.findOne(actor, id);
    if (!from.includes(order.status)) {
      throw new ConflictException(
        `Cannot change a ${order.status} order to ${to}` +
          (order.status === OrderStatus.BILLED
            ? ' (cancel its invoice instead)'
            : ''),
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesOrder.updateMany({
        where: { id, status: { in: from } },
        data: { status: to, ...(reason && { cancelReason: reason }) },
      });
      if (!count)
        throw new ConflictException('The order changed meanwhile; reload it');
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'SalesOrder',
          entityId: id,
          action:
            to === OrderStatus.CANCELLED
              ? AuditAction.CANCEL
              : AuditAction.UPDATE,
          oldValue: { status: order.status },
          newValue: { status: to, reason },
        },
        tx,
      );
    });
    return this.findOne(actor, id);
  }

  private async findByClientUuid(actor: AuthUser, clientUuid: string) {
    const existing = await this.prisma.salesOrder.findUnique({
      where: { clientUuid },
      include: DETAIL_INCLUDE,
    });
    if (!existing) return null;
    const visible =
      existing.tenantId === actor.tenantId &&
      (actor.role !== UserRole.SALESMAN ||
        existing.salesmanId === actor.userId);
    if (!visible) {
      throw new ConflictException(
        'This clientUuid is already used by another order',
      );
    }
    return { ...existing, stockWarnings: [], idempotentReplay: true };
  }

  private async resolveSalesman(actor: AuthUser, salesmanId?: string) {
    if (actor.role === UserRole.SALESMAN || !salesmanId) return actor.userId;
    const user = await this.prisma.user.findFirst({
      where: { id: salesmanId, tenantId: actor.tenantId, isActive: true },
    });
    if (!user || user.role !== UserRole.SALESMAN) {
      throw new BadRequestException('salesmanId must be an active salesman');
    }
    return user.id;
  }

  /** A warning (not a block) for every product the godown can't currently cover. */
  private async stockWarnings(
    actor: AuthUser,
    godownId: string,
    priced: PricedSale,
  ): Promise<StockWarning[]> {
    const wanted = new Map<
      string,
      { line: PricedSale['lines'][number]; qty: Prisma.Decimal }
    >();
    for (const line of priced.lines) {
      const entry = wanted.get(line.product.id);
      wanted.set(line.product.id, {
        line,
        qty: (entry?.qty ?? new Decimal(0)).plus(line.baseQty),
      });
    }
    const warnings: StockWarning[] = [];
    for (const [productId, { line, qty }] of wanted) {
      const available = await this.stock.getBalance(
        this.prisma,
        actor.tenantId,
        godownId,
        productId,
      );
      if (available.lt(qty)) {
        const units = line.product.units;
        const req = fromBase(qty, units).text;
        const have = fromBase(Decimal.max(available, 0), units).text;
        warnings.push({
          productId,
          productName: line.product.name,
          requested: req,
          available: have,
          message: `Only ${have} of ${line.product.name} in stock (ordered ${req})`,
        });
      }
    }
    return warnings;
  }

  private totalsData(priced: PricedSale) {
    const t = priced.totals;
    return {
      subtotal: t.subtotal,
      discount: priced.lines.reduce(
        (s, l) => s.plus(l.discount),
        new Decimal(0),
      ),
      vatAmount: t.vatAmount,
      total: t.total,
    };
  }

  private itemsData(actor: AuthUser, priced: PricedSale) {
    return priced.lines.map((l, i) => ({
      tenantId: actor.tenantId,
      productId: l.product.id,
      unitId: l.unitId,
      quantity: l.quantity,
      baseQuantity: l.baseQty,
      rate: l.rate,
      discountPercent: l.discountPercent,
      discount: l.discount,
      vatAmount: priced.totals.lines[i].vatAmount,
      amount: priced.totals.lines[i].amount,
      priceSource: l.priceSource,
    }));
  }
}
