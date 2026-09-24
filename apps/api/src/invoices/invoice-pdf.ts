import PDFDocument from 'pdfkit';
import { amountInWords } from '../common/billing/amount-in-words.js';
import { formatNpr } from '../common/billing/format.js';
import { formatBS } from '../common/nepali-date/nepali-date.js';
import { InvoiceStatus, Prisma } from '../generated/prisma/client.js';
import type { INVOICE_DETAIL_INCLUDE } from './invoices.service.js';

type Invoice = Prisma.InvoiceGetPayload<{
  include: typeof INVOICE_DETAIL_INCLUDE;
}>;

export interface InvoicePdfInput {
  invoice: Invoice;
  tenant: {
    name: string;
    address: string | null;
    phone: string | null;
    panVatNo: string | null;
  };
  /** 1 = original; later prints are copies. */
  printNo: number;
  printedBy: string;
  printedAt?: Date;
}

const PAGE = { margin: 40, width: 595.28, height: 841.89 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;
const BOTTOM = PAGE.height - PAGE.margin - 40;

// Item table columns: x offset from the left margin, width, alignment.
const COLS = [
  { key: 'sn', title: 'S.N.', w: 28, align: 'left' },
  { key: 'item', title: 'Particulars', w: 207, align: 'left' },
  { key: 'qty', title: 'Qty', w: 70, align: 'right' },
  { key: 'rate', title: 'Rate', w: 70, align: 'right' },
  { key: 'disc', title: 'Discount', w: 60, align: 'right' },
  { key: 'amount', title: 'Amount', w: 80, align: 'right' },
] as const;

const qtyText = (q: Prisma.Decimal) => q.toDecimalPlaces(3).toString();
const adDate = (d: Date) => d.toISOString().slice(0, 10);
/** "2026-09-24 21:55 NPT" */
const nepalTime = (d: Date) =>
  `${d.toLocaleString('sv-SE', { timeZone: 'Asia/Kathmandu' }).slice(0, 16)} NPT`;

/**
 * A4 tax invoice. Built-in PDF fonts can't render Devanagari, so the
 * English product name is printed. TODO: embed a Devanagari font for
 * Nepali names/labels, and verify the layout against current IRD rules.
 */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const { invoice, tenant, printNo } = input;
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE.margin,
    bufferPages: true,
    info: {
      Title: `Tax Invoice ${invoice.fiscalYear}-${invoice.invoiceNo}`,
      Author: tenant.name,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = PAGE.margin;
  const copyLabel = printNo > 1 ? `COPY OF ORIGINAL - Print #${printNo}` : null;

  // ── Header: seller ───────────────────────────────────────────────────────
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .text(tenant.name, { align: 'center' });
  doc.font('Helvetica').fontSize(9);
  if (tenant.address) doc.text(tenant.address, { align: 'center' });
  if (tenant.phone) doc.text(`Phone: ${tenant.phone}`, { align: 'center' });
  doc.text(`PAN/VAT No: ${tenant.panVatNo ?? '-'}`, { align: 'center' });
  doc.moveDown(0.6);
  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .text('TAX INVOICE', { align: 'center' });
  if (copyLabel) {
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#b00020')
      .text(copyLabel, { align: 'center' })
      .fillColor('black');
  }
  doc.moveDown(0.6);

  // ── Invoice details (right) and buyer (left) ─────────────────────────────
  const top = doc.y;
  const half = CONTENT_W / 2;
  doc.font('Helvetica-Bold').fontSize(9).text('Bill To:', left, top);
  doc
    .font('Helvetica')
    .text(invoice.party.name, left, doc.y, { width: half - 10 });
  if (invoice.party.address)
    doc.text(invoice.party.address, { width: half - 10 });
  doc.text(`PAN/VAT No: ${invoice.party.panVatNo ?? '-'}`);
  if (invoice.party.phone) doc.text(`Phone: ${invoice.party.phone}`);
  const leftBottom = doc.y;

  const details: [string, string][] = [
    ['Invoice No', String(invoice.invoiceNo)],
    ['Fiscal Year', invoice.fiscalYear],
    ['Date (BS)', formatBS(invoice.invoiceDate)],
    ['Date (AD)', adDate(invoice.invoiceDate)],
  ];
  if (invoice.order) details.push(['Order No', invoice.order.orderNo]);
  let y = top;
  for (const [label, value] of details) {
    doc.font('Helvetica-Bold').text(`${label}:`, left + half, y, { width: 80 });
    doc
      .font('Helvetica')
      .text(value, left + half + 80, y, { width: half - 80 });
    y += 13;
  }
  doc.y = Math.max(leftBottom, y) + 10;

  // ── Item table ───────────────────────────────────────────────────────────
  const drawRow = (cells: Record<string, string>, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    const heights = COLS.map((c) =>
      doc.heightOfString(cells[c.key] ?? '', { width: c.w - 6 }),
    );
    const h = Math.max(...heights) + 6;
    if (doc.y + h > BOTTOM) {
      doc.addPage();
      drawHeader();
    }
    const rowY = doc.y;
    let x = left;
    for (const c of COLS) {
      doc.text(cells[c.key] ?? '', x + 3, rowY + 3, {
        width: c.w - 6,
        align: c.align,
      });
      x += c.w;
    }
    doc
      .moveTo(left, rowY + h)
      .lineTo(left + CONTENT_W, rowY + h)
      .lineWidth(0.5)
      .strokeColor('#999')
      .stroke()
      .strokeColor('black');
    doc.y = rowY + h;
    doc.x = left;
  };
  const drawHeader = () => {
    const headerY = doc.y;
    doc.rect(left, headerY, CONTENT_W, 18).fill('#eeeeee').fillColor('black');
    doc.y = headerY;
    drawRow(Object.fromEntries(COLS.map((c) => [c.key, c.title])), true);
  };

  drawHeader();
  invoice.items.forEach((item, i) => {
    const batch = item.batch
      ? `\nBatch ${item.batch.batchNo}${item.batch.expiryDate ? `, exp ${adDate(item.batch.expiryDate)}` : ''}`
      : '';
    drawRow({
      sn: String(i + 1),
      item: `${item.product.name}${batch}`,
      qty: `${qtyText(item.quantity)} ${item.unit.name}`,
      rate: formatNpr(item.rate),
      disc: item.discount.isZero()
        ? '-'
        : `${formatNpr(item.discount)}${item.discountPercent.isZero() ? '' : `\n(${item.discountPercent.toString()}%)`}`,
      amount: formatNpr(item.amount),
    });
  });

  // ── Totals ───────────────────────────────────────────────────────────────
  const exempt = invoice.subtotal
    .minus(invoice.discount)
    .minus(invoice.taxableAmount);
  const totals: [string, string, boolean?][] = [
    ['Sub Total', formatNpr(invoice.subtotal)],
    ['Discount', formatNpr(invoice.discount)],
    ['Taxable Amount', formatNpr(invoice.taxableAmount)],
  ];
  if (!exempt.isZero()) totals.push(['Non-taxable Amount', formatNpr(exempt)]);
  totals.push(['VAT 13%', formatNpr(invoice.vatAmount)]);
  totals.push(['Grand Total', formatNpr(invoice.total), true]);

  if (doc.y + totals.length * 15 + 60 > BOTTOM) doc.addPage();
  doc.moveDown(0.5);
  const labelX = left + CONTENT_W - 230;
  for (const [label, value, bold] of totals) {
    const rowY = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9);
    doc.text(label, labelX, rowY, { width: 130 });
    doc.text(`Rs ${value}`, labelX + 130, rowY, { width: 100, align: 'right' });
    doc.y = rowY + (bold ? 17 : 14);
  }

  doc.moveDown(0.8);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('In words: ', left, doc.y, { continued: true });
  doc
    .font('Helvetica')
    .text(amountInWords(invoice.total), { width: CONTENT_W });

  if (invoice.status === InvoiceStatus.CANCELLED) {
    doc.moveDown(0.5);
    doc
      .font('Helvetica-Bold')
      .fillColor('#b00020')
      .text(`CANCELLED: ${invoice.cancelReason ?? ''}`, { width: CONTENT_W })
      .fillColor('black');
  }

  // ── Footer and watermark on every page ──────────────────────────────────
  const printedAt = input.printedAt ?? new Date();
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    if (invoice.status === InvoiceStatus.CANCELLED) {
      doc.save();
      doc.rotate(-35, { origin: [PAGE.width / 2, PAGE.height / 2] });
      doc
        .font('Helvetica-Bold')
        .fontSize(96)
        .fillColor('#b00020')
        .opacity(0.18)
        .text('CANCELLED', 0, PAGE.height / 2 - 50, {
          width: PAGE.width,
          align: 'center',
          lineBreak: false,
        });
      doc.restore();
      doc.opacity(1).fillColor('black');
    }
    const footerY = PAGE.height - PAGE.margin - 20;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(
      `${copyLabel ?? 'ORIGINAL'} | Printed by ${input.printedBy} on ${nepalTime(printedAt)} | Page ${p - range.start + 1} of ${range.count}`,
      left,
      footerY,
      { width: CONTENT_W, align: 'center', lineBreak: false },
    );
    doc.text('This is a computer generated invoice.', left, footerY + 9, {
      width: CONTENT_W,
      align: 'center',
      lineBreak: false,
    });
    doc.fillColor('black');
  }

  doc.end();
  return done;
}
