import PDFDocument from 'pdfkit';
import { amountInWords, formatNpr } from '../common/billing.js';
import { formatBS } from '../common/nepali-date.js';
import { Decimal, PaymentDirection, PaymentMethod, PaymentStatus } from '../db.js';

// 80 mm thermal roll: 226.77 pt wide, ~72 mm printable.
const WIDTH = 226.77;
const MARGIN = 10;
const W = WIDTH - MARGIN * 2;

/**
 * Small money receipt for 80 mm thermal printers (height grows with content).
 * @param {{ payment: object, tenant: { name: string, address: string | null,
 *   phone: string | null, panVatNo: string | null } }} input  payment as returned by findOne
 * @returns {Promise<Buffer>}
 */
export function renderReceiptPdf({ payment, tenant }) {
  const incoming = payment.direction === PaymentDirection.IN;
  const netAllocations = netByInvoice(payment.allocations);
  const height =
    300 +
    netAllocations.length * 12 +
    (payment.method === PaymentMethod.CHEQUE ? 50 : 0) +
    (payment.status === PaymentStatus.REVERSED ? 14 : 0) +
    (payment.note ? 24 : 0);
  const doc = new PDFDocument({ size: [WIDTH, height], margin: MARGIN });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const line = () => {
    doc.moveDown(0.3);
    doc.moveTo(MARGIN, doc.y).lineTo(WIDTH - MARGIN, doc.y).dash(2, { space: 2 }).stroke().undash();
    doc.moveDown(0.4);
  };
  const row = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    doc.text(label, MARGIN, y, { width: W * 0.42 });
    const h1 = doc.y - y;
    doc.text(value, MARGIN + W * 0.42, y, { width: W * 0.58, align: 'right' });
    doc.y = Math.max(y + h1, doc.y);
  };

  doc.font('Helvetica-Bold').fontSize(11).text(tenant.name, { align: 'center', width: W });
  doc.font('Helvetica').fontSize(7.5);
  if (tenant.address) doc.text(tenant.address, { align: 'center', width: W });
  if (tenant.phone) doc.text(`Ph: ${tenant.phone}`, { align: 'center', width: W });
  doc.text(`PAN/VAT: ${tenant.panVatNo ?? '-'}`, { align: 'center', width: W });
  doc.moveDown(0.4);
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(incoming ? 'PAYMENT RECEIPT' : 'PAYMENT VOUCHER', { align: 'center', width: W });
  if (payment.status === PaymentStatus.REVERSED) {
    doc
      .fillColor('#b00020')
      .fontSize(9)
      .text(payment.chequeStatus === 'BOUNCED' ? '*** CHEQUE BOUNCED ***' : '*** REVERSED ***', {
        align: 'center',
        width: W,
      })
      .fillColor('black');
  }
  line();

  row('Receipt No', `${payment.fiscalYear}-${payment.receiptNo}`);
  row('Date (BS)', formatBS(payment.paymentDate));
  row('Date (AD)', payment.paymentDate.toISOString().slice(0, 10));
  row(incoming ? 'Received from' : 'Paid to', payment.party.name);
  if (payment.party.panVatNo) row('PAN', payment.party.panVatNo);
  line();

  row('Amount', `Rs ${formatNpr(payment.amount)}`, true);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(7.5).text(amountInWords(payment.amount), MARGIN, doc.y, { width: W });
  doc.moveDown(0.3);
  row('Method', payment.method);
  if (payment.method === PaymentMethod.CHEQUE) {
    row('Cheque No', payment.chequeNo ?? '-');
    row('Bank', payment.chequeBank ?? '-');
    row('Cheque date', payment.chequeDate?.toISOString().slice(0, 10) ?? '-');
    row('Cheque status', payment.chequeStatus ?? '-');
  }
  if (payment.referenceNo) row('Reference', payment.referenceNo);

  if (incoming) {
    line();
    doc.font('Helvetica-Bold').fontSize(8).text('Against invoices', MARGIN, doc.y, { width: W });
    if (!netAllocations.length) doc.font('Helvetica').text('None (advance)', { width: W });
    for (const a of netAllocations) {
      row(`Inv ${a.fiscalYear}-${a.invoiceNo}`, `Rs ${formatNpr(a.amount)}`);
    }
    if (payment.unallocatedAmount.gt(0)) {
      row('Advance', `Rs ${formatNpr(payment.unallocatedAmount)}`);
    }
  }
  line();
  if (payment.balanceAfterPayment) {
    row(
      'Balance after payment',
      `Rs ${formatNpr(payment.balanceAfterPayment.abs())} ${payment.balanceAfterPayment.lt(0) ? 'Cr' : 'Dr'}`,
      true,
    );
  }
  row('Collected by', payment.collectedBy.name);
  if (payment.note) {
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(7.5).text(`Note: ${payment.note}`, MARGIN, doc.y, { width: W });
  }
  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(7).text('Thank you!', { align: 'center', width: W });

  doc.end();
  return done;
}

/** Allocations net of reversal rows, grouped per invoice. */
function netByInvoice(allocations) {
  const byInvoice = new Map();
  for (const a of allocations) {
    const entry = byInvoice.get(a.invoiceId) ?? {
      invoiceNo: a.invoice.invoiceNo,
      fiscalYear: a.invoice.fiscalYear,
      amount: new Decimal(0),
    };
    entry.amount = entry.amount.plus(a.amount);
    byInvoice.set(a.invoiceId, entry);
  }
  return [...byInvoice.values()].filter((a) => !a.amount.isZero());
}
