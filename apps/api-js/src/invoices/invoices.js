import { randomUUID } from 'node:crypto';
import { paymentInfo } from '../accounts/outstanding.js';
import { auditLog } from '../common/audit.js';
import { nepalToday, nepalTodayString } from '../common/dates.js';
import { postLedger } from '../common/ledger.js';
import { getFiscalYear } from '../common/nepali-date.js';
import { nextInvoiceNo } from '../common/numbering.js';
import { pageArgs, paginationDefaults, paginationFields } from '../common/pagination.js';
import { assertApprovalUsable, checkCredit, creditBlocked, markApprovalUsed } from '../credit/credit.js';
import {
  AuditAction,
  Decimal,
  InvoiceStatus,
  LedgerEntryType,
  MovementType,
  OrderStatus,
  Prisma,
  UserRole,
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
  isBoolean,
  isEnum,
  isNumber,
  isString,
  isUuid,
  matches,
  max,
  min,
  nested,
  optional,
  queryBoolean,
  schema,
} from '../http/validation.js';
import { MAX_MONEY } from '../pricing/pricing.js';
import { CancelDto, SaleItemDto } from '../sales-orders/sales-orders.js';
import { getCustomer, priceSale } from '../sales/sale-lines.js';
import { allocateFEFO, averageCosts, postMovements, reverseMovements } from '../stock/stock-engine.js';
import { renderInvoicePdf } from './invoice-pdf.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const CreateInvoiceDto = schema({
  partyId: [isUuid()],
  /** Required unless orderId is given (then the order's godown) */
  godownId: [optional(), isUuid()],
  /** Bill a CONFIRMED sales order */
  orderId: [optional(), isUuid()],
  /** Omit to bill the order's items. No prices: the server prices every line. */
  items: [optional(), isArray(), arrayMinSize(1), arrayMaxSize(200), nested(SaleItemDto)],
  /** Bill-level discount amount (before VAT) */
  discountAmount: [optional(), isNumber({ maxDecimalPlaces: 2 }), min(0), max(MAX_MONEY)],
  /** An APPROVED credit approval, if the party is over its limit */
  creditApprovalId: [optional(), isUuid()],
});

const ListInvoicesQueryDto = schema(
  {
    partyId: [optional(), isUuid()],
    status: [optional(), isEnum(InvoiceStatus)],
    fiscalYear: [optional(), isString(), matches(/^\d{4}\/\d{2}$/, 'fiscalYear must look like 2083/84')],
    /** Invoice date (AD) from */
    from: [optional(), dateOnly()],
    /** Invoice date (AD) to */
    to: [optional(), dateOnly()],
    /** Only issued invoices with something still owed */
    unpaid: [optional(), queryBoolean(), isBoolean()],
    /** Only unpaid invoices past invoice date + party credit days */
    overdue: [optional(), queryBoolean(), isBoolean()],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

// ─── Lines split by batch ───────────────────────────────────────────────────

const round2 = (d) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * An invoice line whose stock comes from several batches (FEFO) becomes one
 * invoice item per batch. Base quantities are exact; money and the unit
 * quantity are split in proportion, with the last part taking the rounding
 * remainder so the parts always add up to the original line.
 * @param {{ quantity: Decimal, baseQty: Decimal, discount: Decimal, amount: Decimal,
 *   vatAmount: Decimal }} line  quantity is in the sold unit
 * @param {Array<{ batchId: string | null, qty: Decimal }>} allocations
 */
export function splitLineByBatches(line, allocations) {
  if (allocations.length === 1) {
    const { baseQty, ...money } = line;
    return [{ ...money, batchId: allocations[0].batchId, baseQuantity: baseQty }];
  }
  let left = {
    quantity: line.quantity,
    discount: line.discount,
    amount: line.amount,
    vatAmount: line.vatAmount,
  };
  return allocations.map((a, i) => {
    if (i === allocations.length - 1) return { ...left, batchId: a.batchId, baseQuantity: a.qty };
    const ratio = a.qty.div(line.baseQty);
    const part = {
      quantity: line.quantity.mul(ratio).toDecimalPlaces(3, Decimal.ROUND_HALF_UP),
      discount: round2(line.discount.mul(ratio)),
      amount: round2(line.amount.mul(ratio)),
      vatAmount: round2(line.vatAmount.mul(ratio)),
    };
    left = {
      quantity: left.quantity.minus(part.quantity),
      discount: left.discount.minus(part.discount),
      amount: left.amount.minus(part.amount),
      vatAmount: left.vatAmount.minus(part.vatAmount),
    };
    return { ...part, batchId: a.batchId, baseQuantity: a.qty };
  });
}

// ─── Service ────────────────────────────────────────────────────────────────

export const INVOICE_REF = 'INVOICE';

export const INVOICE_DETAIL_INCLUDE = {
  party: {
    select: { id: true, name: true, address: true, panVatNo: true, phone: true, creditDays: true },
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
};

/**
 * Lists invoices with payment status. `unpaid` / `overdue` filter on derived
 * values (total - allocations, invoice date + credit days), so ids are
 * selected in SQL first.
 */
export async function list(actor, q) {
  const conds = [Prisma.sql`i.tenant_id = ${actor.tenantId}`];
  if (q.partyId) conds.push(Prisma.sql`i.party_id = ${q.partyId}`);
  if (q.status) conds.push(Prisma.sql`i.status = ${q.status}::"InvoiceStatus"`);
  if (q.fiscalYear) conds.push(Prisma.sql`i.fiscal_year = ${q.fiscalYear}`);
  if (q.from) conds.push(Prisma.sql`i.invoice_date >= ${q.from}::date`);
  if (q.to) conds.push(Prisma.sql`i.invoice_date <= ${q.to}::date`);
  if (q.unpaid || q.overdue) {
    conds.push(Prisma.sql`i.status = 'ISSUED' AND i.total - COALESCE(a.paid, 0) > 0`);
  }
  if (q.overdue) {
    conds.push(Prisma.sql`i.invoice_date + p.credit_days < ${nepalTodayString()}::date`);
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
    prisma.$queryRaw`
      SELECT i.id ${from}
      ORDER BY i.fiscal_year DESC, i.invoice_no DESC
      LIMIT ${take} OFFSET ${skip}`,
    prisma.$queryRaw`SELECT COUNT(*) AS n ${from}`,
  ]);
  const ids = idRows.map((r) => r.id);
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: ids } },
    include: { party: { select: { id: true, name: true, creditDays: true } } },
  });
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const info = await paymentInfo(prisma, invoices);
  return {
    items: ids.map((id) => ({ ...byId.get(id), ...info.get(id) })),
    total: Number(countRows[0].n),
    page: q.page,
    limit: q.limit,
  };
}

/** Invoice with items, payments applied, outstanding, due date and overdue flag. */
export async function findOne(actor, id) {
  const invoice = await prisma.invoice.findFirst({
    where: { id, tenantId: actor.tenantId },
    include: INVOICE_DETAIL_INCLUDE,
  });
  if (!invoice) throw NotFound('Invoice not found');
  const info = await paymentInfo(prisma, [invoice]);
  return { ...invoice, ...info.get(invoice.id) };
}

/**
 * Issues a tax invoice. Prices, VAT and totals are always worked out here.
 * In ONE transaction: credit check (party row locked), FEFO stock allocation
 * and SALE movements, next invoice number, invoice + items, DEBIT ledger
 * entry, order -> BILLED, approval -> USED, audit.
 */
export async function create(actor, dto) {
  const order = dto.orderId ? await billableOrder(actor, dto) : null;
  const party = await getCustomer(actor, dto.partyId);
  const godownId = dto.godownId ?? order?.godownId;
  if (!godownId) throw BadRequest('godownId is required');
  const godown = await getActiveGodown(actor, godownId);

  const items =
    dto.items ??
    order?.items.map((i) => ({
      productId: i.productId,
      unitId: i.unitId,
      quantity: i.quantity,
      discountPercent: i.discountPercent,
    })) ??
    [];
  const { lines, totals } = await priceSale(actor, party.id, items, new Decimal(dto.discountAmount ?? 0));

  const invoiceId = randomUUID();
  const now = new Date();
  const fiscalYear = getFiscalYear(now);

  await prisma.$transaction(
    async (tx) => {
      // Serialise billing per party so two invoices can't both pass the credit check.
      await tx.$queryRaw`SELECT id FROM parties WHERE id = ${party.id} FOR UPDATE`;
      const decision = await checkCredit(tx, actor.tenantId, party, totals.total);
      if (!decision.allowed) {
        if (!dto.creditApprovalId) throw creditBlocked(party.name, decision);
        await assertApprovalUsable(tx, actor, dto.creditApprovalId, {
          partyId: party.id,
          total: totals.total,
        });
      }

      const costs = await averageCosts(
        tx,
        actor.tenantId,
        lines.map((l) => l.product.id),
      );
      const itemRows = [];
      for (const [i, line] of lines.entries()) {
        // FEFO for batch-tracked products. Posting line by line lets the next
        // line's allocation see this line's stock-out.
        const allocations = line.product.trackBatch
          ? await allocateFEFO(tx, actor.tenantId, godown.id, line.product.id, line.baseQty)
          : [{ batchId: null, qty: line.baseQty }];
        await postMovements(
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

      if (!decision.allowed) await markApprovalUsed(tx, dto.creditApprovalId, invoiceId);

      await postLedger(tx, {
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
        if (!count) throw Conflict('The order was billed or changed meanwhile');
      }

      await auditLog(
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
            creditApprovalId: decision.allowed ? undefined : dto.creditApprovalId,
          },
        },
        tx,
      );
    },
    { timeout: 30_000 },
  );
  return findOne(actor, invoiceId);
}

/**
 * Cancels an invoice. It is never deleted and keeps its number: the status
 * becomes CANCELLED, stock comes back and an opposite CREDIT ledger entry is
 * posted, in one transaction. A billed order goes back to CONFIRMED.
 */
export async function cancel(actor, id, reason) {
  const invoice = await findOne(actor, id);
  if (invoice.status === InvoiceStatus.CANCELLED) throw Conflict('This invoice is already cancelled');
  await prisma.$transaction(
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
      if (!count) throw Conflict('This invoice is already cancelled');

      await reverseMovements(tx, actor.tenantId, INVOICE_REF, id, actor.userId);
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
            amount: a._sum.amount.neg(),
          })),
        });
      }
      await postLedger(tx, {
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
      await auditLog(
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
  return findOne(actor, id);
}

/** Counts a print (audited) and returns the invoice data plus the print number. */
export async function recordPrint(actor, id) {
  const invoice = await findOne(actor, id);
  const printNo = await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { printCount: { increment: 1 } },
      select: { printCount: true },
    });
    await auditLog(
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
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
  const printedBy = await prisma.user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { name: true },
  });
  return { invoice, tenant, printNo, printedBy: printedBy.name };
}

async function billableOrder(actor, dto) {
  const order = await prisma.salesOrder.findFirst({
    where: { id: dto.orderId, tenantId: actor.tenantId },
    include: { items: true },
  });
  if (!order) throw BadRequest('Sales order not found');
  if (order.partyId !== dto.partyId) throw BadRequest('The order belongs to a different party');
  if (order.status === OrderStatus.DRAFT) throw BadRequest('Confirm the order before billing it');
  if (order.status !== OrderStatus.CONFIRMED) throw Conflict(`This order is already ${order.status}`);
  return order;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** Sends a PDF buffer inline with a file name. */
export function sendPdf(res, pdf, name) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Content-Length', pdf.length);
  res.status(200).end(pdf);
}

const r = controller('/invoices', { roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE] });

r.get('/', { query: ListInvoicesQueryDto }, ({ user, query }) => list(user, query));
r.get('/:id', { params: { id: 'uuid' } }, ({ user, params }) => findOne(user, params.id));
// Issue a VAT invoice. The server prices every line; stock (FEFO), ledger, numbering in one transaction.
r.post('/', { body: CreateInvoiceDto }, ({ user, body }) => create(user, body));
// Cancel (never deleted, keeps its number): stock back, opposite ledger entry
r.post(
  '/:id/cancel',
  { roles: [UserRole.OWNER, UserRole.MANAGER], status: 200, params: { id: 'uuid' }, body: CancelDto },
  ({ user, params, body }) => cancel(user, params.id, body.reason),
);
// A4 tax invoice PDF. First print is the original; later ones say "COPY OF ORIGINAL - Print #n".
r.get('/:id/pdf', { params: { id: 'uuid' } }, async ({ user, params, res }) => {
  const data = await recordPrint(user, params.id);
  const pdf = await renderInvoicePdf(data);
  sendPdf(res, pdf, `invoice-${data.invoice.fiscalYear.replace('/', '-')}-${data.invoice.invoiceNo}.pdf`);
});

export const invoicesRoutes = r;
