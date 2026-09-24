import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OutstandingService } from '../accounts/outstanding.service.js';
import { AuditService } from '../audit/audit.service.js';
import { nepalToday, nepalTodayString } from '../common/dates.js';
import { getFiscalYear } from '../common/nepali-date/nepali-date.js';
import { nextInvoiceNo } from '../common/numbering/numbering.js';
import { pageArgs } from '../common/pagination.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  CreditBlockedException,
  CreditService,
} from '../credit/credit.service.js';
import {
  AuditAction,
  InvoiceStatus,
  LedgerEntryType,
  MovementType,
  OrderStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { GodownsService } from '../godowns/godowns.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type SaleItemInput,
  SaleLinesService,
} from '../sales/sale-lines.service.js';
import { StockService } from '../stock/stock.service.js';
import { splitLineByBatches } from './invoice-lines.js';
import type { CreateInvoiceDto, ListInvoicesQueryDto } from './invoices.dto.js';

const { Decimal } = Prisma;
export const INVOICE_REF = 'INVOICE';

export const INVOICE_DETAIL_INCLUDE = {
  party: {
    select: {
      id: true,
      name: true,
      address: true,
      panVatNo: true,
      phone: true,
      creditDays: true,
    },
  },
  godown: { select: { id: true, name: true } },
  order: { select: { id: true, orderNo: true } },
  allocations: {
    include: {
      payment: {
        select: {
          id: true,
          fiscalYear: true,
          receiptNo: true,
          paymentDate: true,
          method: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
  createdBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  creditApproval: { select: { id: true, amount: true, approvedById: true } },
  items: {
    include: {
      product: { select: { id: true, sku: true, name: true, baseUnit: true } },
      unit: { select: { id: true, name: true } },
      batch: { select: { id: true, batchNo: true, expiryDate: true } },
    },
    orderBy: [{ lineNo: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly lines: SaleLinesService,
    private readonly stock: StockService,
    private readonly ledger: LedgerService,
    private readonly credit: CreditService,
    private readonly godowns: GodownsService,
    private readonly outstanding: OutstandingService,
  ) {}

  /**
   * Lists invoices with payment status. `unpaid` / `overdue` filter on derived
   * values (total - allocations, invoice date + credit days), so ids are
   * selected in SQL first.
   */
  async list(actor: AuthUser, q: ListInvoicesQueryDto) {
    const conds: Prisma.Sql[] = [Prisma.sql`i.tenant_id = ${actor.tenantId}`];
    if (q.partyId) conds.push(Prisma.sql`i.party_id = ${q.partyId}`);
    if (q.status)
      conds.push(Prisma.sql`i.status = ${q.status}::"InvoiceStatus"`);
    if (q.fiscalYear) conds.push(Prisma.sql`i.fiscal_year = ${q.fiscalYear}`);
    if (q.from) conds.push(Prisma.sql`i.invoice_date >= ${q.from}::date`);
    if (q.to) conds.push(Prisma.sql`i.invoice_date <= ${q.to}::date`);
    if (q.unpaid || q.overdue) {
      conds.push(
        Prisma.sql`i.status = 'ISSUED' AND i.total - COALESCE(a.paid, 0) > 0`,
      );
    }
    if (q.overdue) {
      conds.push(
        Prisma.sql`i.invoice_date + p.credit_days < ${nepalTodayString()}::date`,
      );
    }
    const from = Prisma.sql`
      FROM invoices i
      JOIN parties p ON p.id = i.party_id
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS paid FROM payment_allocations
        WHERE tenant_id = ${actor.tenantId} GROUP BY invoice_id
      ) a ON a.invoice_id = i.id
      WHERE ${Prisma.join(conds, ' AND ')}`;
    const { skip, take } = pageArgs(q);
    const [idRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT i.id ${from}
        ORDER BY i.fiscal_year DESC, i.invoice_no DESC
        LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n ${from}`,
    ]);
    const ids = idRows.map((r) => r.id);
    const invoices = await this.prisma.invoice.findMany({
      where: { id: { in: ids } },
      include: {
        party: { select: { id: true, name: true, creditDays: true } },
      },
    });
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const info = await this.outstanding.paymentInfo(this.prisma, invoices);
    return {
      items: ids.map((id) => ({ ...byId.get(id)!, ...info.get(id)! })),
      total: Number(countRows[0].n),
      page: q.page,
      limit: q.limit,
    };
  }

  /** Invoice with items, payments applied, outstanding, due date and overdue flag. */
  async findOne(actor: AuthUser, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: INVOICE_DETAIL_INCLUDE,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    const info = await this.outstanding.paymentInfo(this.prisma, [invoice]);
    return { ...invoice, ...info.get(invoice.id)! };
  }

  /**
   * Issues a tax invoice. Prices, VAT and totals are always worked out here.
   * In ONE transaction: credit check (party row locked), FEFO stock allocation
   * and SALE movements, next invoice number, invoice + items, DEBIT ledger
   * entry, order -> BILLED, approval -> USED, audit.
   */
  async create(actor: AuthUser, dto: CreateInvoiceDto) {
    const order = dto.orderId ? await this.billableOrder(actor, dto) : null;
    const party = await this.lines.getCustomer(actor, dto.partyId);
    const godownId = dto.godownId ?? order?.godownId;
    if (!godownId) throw new BadRequestException('godownId is required');
    const godown = await this.godowns.getActive(actor, godownId);

    const items: SaleItemInput[] =
      dto.items ??
      order?.items.map((i) => ({
        productId: i.productId,
        unitId: i.unitId,
        quantity: i.quantity,
        discountPercent: i.discountPercent,
      })) ??
      [];
    const { lines, totals } = await this.lines.price(
      actor,
      party.id,
      items,
      new Decimal(dto.discountAmount ?? 0),
    );

    const invoiceId = randomUUID();
    const now = new Date();
    const fiscalYear = getFiscalYear(now);

    await this.prisma.$transaction(
      async (tx) => {
        // Serialise billing per party so two invoices can't both pass the credit check.
        await tx.$queryRaw`SELECT id FROM parties WHERE id = ${party.id} FOR UPDATE`;
        const decision = await this.credit.checkCredit(
          tx,
          actor.tenantId,
          party,
          totals.total,
        );
        if (!decision.allowed) {
          if (!dto.creditApprovalId) {
            throw new CreditBlockedException(party.name, decision);
          }
          await this.credit.assertApprovalUsable(
            tx,
            actor,
            dto.creditApprovalId,
            {
              partyId: party.id,
              total: totals.total,
            },
          );
        }

        const costs = await this.stock.averageCosts(
          tx,
          actor.tenantId,
          lines.map((l) => l.product.id),
        );
        const itemRows: Prisma.InvoiceItemCreateManyInvoiceInput[] = [];
        for (const [i, line] of lines.entries()) {
          // FEFO for batch-tracked products. Posting line by line lets the next
          // line's allocation see this line's stock-out.
          const allocations = line.product.trackBatch
            ? await this.stock.allocateFEFO(
                tx,
                actor.tenantId,
                godown.id,
                line.product.id,
                line.baseQty,
              )
            : [{ batchId: null, qty: line.baseQty }];
          await this.stock.postMovements(
            tx,
            allocations.map((a) => ({
              tenantId: actor.tenantId,
              godownId: godown.id,
              productId: line.product.id,
              batchId: a.batchId,
              type: MovementType.SALE,
              quantity: a.qty.neg(),
              unitCost: costs.get(line.product.id) ?? new Decimal(0),
              refType: INVOICE_REF,
              refId: invoiceId,
              createdById: actor.userId,
            })),
          );

          const t = totals.lines[i];
          for (const part of splitLineByBatches(
            {
              quantity: line.quantity,
              baseQty: line.baseQty,
              discount: line.discount,
              amount: t.amount,
              vatAmount: t.vatAmount,
            },
            allocations,
          )) {
            itemRows.push({
              tenantId: actor.tenantId,
              lineNo: line.lineNo,
              productId: line.product.id,
              unitId: line.unitId,
              batchId: part.batchId,
              quantity: part.quantity,
              baseQuantity: part.baseQuantity,
              rate: line.rate,
              discountPercent: line.discountPercent,
              discount: part.discount,
              vatAmount: part.vatAmount,
              amount: part.amount,
              priceSource: line.priceSource,
            });
          }
        }

        const invoiceNo = await nextInvoiceNo(tx, actor.tenantId, fiscalYear);
        await tx.invoice.create({
          data: {
            id: invoiceId,
            tenantId: actor.tenantId,
            fiscalYear,
            invoiceNo,
            invoiceDate: nepalToday(now),
            partyId: party.id,
            orderId: order?.id,
            godownId: godown.id,
            subtotal: totals.subtotal,
            discount: totals.discount,
            taxableAmount: totals.taxableAmount,
            vatAmount: totals.vatAmount,
            total: totals.total,
            createdById: actor.userId,
            items: { createMany: { data: itemRows } },
          },
        });

        if (!decision.allowed) {
          await this.credit.markApprovalUsed(
            tx,
            dto.creditApprovalId!,
            invoiceId,
          );
        }

        await this.ledger.post(tx, {
          tenantId: actor.tenantId,
          partyId: party.id,
          entryDate: nepalToday(now),
          type: LedgerEntryType.INVOICE,
          debit: totals.total,
          refType: INVOICE_REF,
          refId: invoiceId,
          narration: `Invoice ${invoiceNo} (${fiscalYear})`,
        });

        if (order) {
          const { count } = await tx.salesOrder.updateMany({
            where: { id: order.id, status: OrderStatus.CONFIRMED },
            data: { status: OrderStatus.BILLED },
          });
          if (!count)
            throw new ConflictException(
              'The order was billed or changed meanwhile',
            );
        }

        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Invoice',
            entityId: invoiceId,
            action: AuditAction.CREATE,
            newValue: {
              fiscalYear,
              invoiceNo,
              partyId: party.id,
              orderId: order?.id,
              total: totals.total,
              creditApprovalId: decision.allowed
                ? undefined
                : dto.creditApprovalId,
            },
          },
          tx,
        );
      },
      { timeout: 30_000 },
    );
    return this.findOne(actor, invoiceId);
  }

  /**
   * Cancels an invoice. It is never deleted and keeps its number: the status
   * becomes CANCELLED, stock comes back and an opposite CREDIT ledger entry is
   * posted, in one transaction. A billed order goes back to CONFIRMED.
   */
  async cancel(actor: AuthUser, id: string, reason: string) {
    const invoice = await this.findOne(actor, id);
    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new ConflictException('This invoice is already cancelled');
    }
    await this.prisma.$transaction(
      async (tx) => {
        const { count } = await tx.invoice.updateMany({
          where: { id, tenantId: actor.tenantId, status: InvoiceStatus.ISSUED },
          data: {
            status: InvoiceStatus.CANCELLED,
            cancelReason: reason,
            cancelledAt: new Date(),
            cancelledById: actor.userId,
          },
        });
        if (!count)
          throw new ConflictException('This invoice is already cancelled');

        await this.stock.reverseMovements(
          tx,
          actor.tenantId,
          INVOICE_REF,
          id,
          actor.userId,
        );
        // Payments applied to this invoice become unallocated advance again
        // (negative allocation rows; nothing is deleted).
        const applied = await tx.paymentAllocation.groupBy({
          by: ['paymentId'],
          where: { invoiceId: id },
          _sum: { amount: true },
        });
        const release = applied.filter((a) => a._sum.amount?.gt(0));
        if (release.length) {
          await tx.paymentAllocation.createMany({
            data: release.map((a) => ({
              tenantId: actor.tenantId,
              paymentId: a.paymentId,
              invoiceId: id,
              amount: a._sum.amount!.neg(),
            })),
          });
        }
        await this.ledger.post(tx, {
          tenantId: actor.tenantId,
          partyId: invoice.partyId,
          entryDate: nepalToday(),
          type: LedgerEntryType.INVOICE,
          credit: invoice.total,
          refType: INVOICE_REF,
          refId: id,
          narration: `Invoice ${invoice.invoiceNo} (${invoice.fiscalYear}) cancelled: ${reason}`,
        });
        if (invoice.orderId) {
          await tx.salesOrder.updateMany({
            where: { id: invoice.orderId, status: OrderStatus.BILLED },
            data: { status: OrderStatus.CONFIRMED },
          });
        }
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Invoice',
            entityId: id,
            action: AuditAction.CANCEL,
            oldValue: { status: InvoiceStatus.ISSUED },
            newValue: { status: InvoiceStatus.CANCELLED, reason },
          },
          tx,
        );
      },
      { timeout: 30_000 },
    );
    return this.findOne(actor, id);
  }

  /** Counts a print (audited) and returns the invoice data plus the print number. */
  async recordPrint(actor: AuthUser, id: string) {
    const invoice = await this.findOne(actor, id);
    const printNo = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.invoice.update({
        where: { id: invoice.id },
        data: { printCount: { increment: 1 } },
        select: { printCount: true },
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Invoice',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: { printCount: updated.printCount - 1 },
          newValue: {
            printCount: updated.printCount,
            print: updated.printCount === 1 ? 'ORIGINAL' : 'COPY OF ORIGINAL',
          },
        },
        tx,
      );
      return updated.printCount;
    });
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
    });
    const printedBy = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { name: true },
    });
    return { invoice, tenant, printNo, printedBy: printedBy.name };
  }

  private async billableOrder(actor: AuthUser, dto: CreateInvoiceDto) {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id: dto.orderId, tenantId: actor.tenantId },
      include: { items: true },
    });
    if (!order) throw new BadRequestException('Sales order not found');
    if (order.partyId !== dto.partyId) {
      throw new BadRequestException('The order belongs to a different party');
    }
    if (order.status === OrderStatus.DRAFT) {
      throw new BadRequestException('Confirm the order before billing it');
    }
    if (order.status !== OrderStatus.CONFIRMED) {
      throw new ConflictException(`This order is already ${order.status}`);
    }
    return order;
  }
}
