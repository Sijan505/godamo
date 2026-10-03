import PDFDocument from 'pdfkit';
import { formatNpr } from '../common/billing.js';
import { formatBS } from '../common/nepali-date.js';

const PAGE = { margin: 36, width: 595.28, height: 841.89 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;
const BOTTOM = PAGE.height - PAGE.margin - 30;
const COLS = [
  { key: 'bs', title: 'Date (BS)', w: 62, align: 'left' },
  { key: 'ad', title: 'Date (AD)', w: 62, align: 'left' },
  { key: 'doc', title: 'Particulars', w: 159, align: 'left' },
  { key: 'dr', title: 'Debit', w: 80, align: 'right' },
  { key: 'cr', title: 'Credit', w: 80, align: 'right' },
  { key: 'bal', title: 'Balance', w: 80, align: 'right' },
];

const drCr = (d) => `${formatNpr(d.abs())} ${d.lt(0) ? 'Cr' : 'Dr'}`;
const money = (d) => (d.isZero() ? '' : formatNpr(d));

/**
 * A4 party ledger statement.
 * @param {object} s a statement from party-accounts statement()
 * @param {{ name: string, address: string | null, panVatNo: string | null }} tenant
 * @returns {Promise<Buffer>}
 */
export function renderLedgerPdf(s, tenant) {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = PAGE.margin;

  doc.font('Helvetica-Bold').fontSize(14).text(tenant.name, { align: 'center' });
  doc.font('Helvetica').fontSize(8.5);
  if (tenant.address) doc.text(tenant.address, { align: 'center' });
  doc.text(`PAN/VAT No: ${tenant.panVatNo ?? '-'}`, { align: 'center' });
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(12).text('PARTY LEDGER STATEMENT', { align: 'center' });
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(9).text(s.party.name, left);
  doc.font('Helvetica');
  if (s.party.address) doc.text(s.party.address);
  doc.text(`PAN/VAT No: ${s.party.panVatNo ?? '-'}${s.party.phone ? `   Phone: ${s.party.phone}` : ''}`);
  const period =
    s.from || s.to
      ? `Period: ${s.from ? `${formatBS(new Date(`${s.from}T00:00:00Z`))} BS (${s.from})` : 'start'} to ${s.to ? `${formatBS(new Date(`${s.to}T00:00:00Z`))} BS (${s.to})` : 'today'}`
      : 'Period: all entries';
  doc.text(period);
  doc.moveDown(0.6);

  const drawRow = (cells, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const h = Math.max(...COLS.map((c) => doc.heightOfString(cells[c.key] ?? '', { width: c.w - 4 }))) + 5;
    if (doc.y + h > BOTTOM) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    let x = left;
    for (const c of COLS) {
      doc.text(cells[c.key] ?? '', x + 2, y + 2.5, { width: c.w - 4, align: c.align });
      x += c.w;
    }
    doc
      .moveTo(left, y + h)
      .lineTo(left + CONTENT_W, y + h)
      .lineWidth(0.4)
      .strokeColor('#aaa')
      .stroke()
      .strokeColor('black');
    doc.y = y + h;
    doc.x = left;
  };
  const drawHeader = () => {
    doc.rect(left, doc.y, CONTENT_W, 16).fill('#eeeeee').fillColor('black');
    drawRow(Object.fromEntries(COLS.map((c) => [c.key, c.title])), true);
  };

  drawHeader();
  drawRow({ doc: 'Opening balance', bal: drCr(s.openingBalance) }, true);
  for (const e of s.entries) {
    drawRow({
      bs: e.dateBs,
      ad: e.date,
      doc: [e.documentNo, e.narration].filter(Boolean).join('\n'),
      dr: money(e.debit),
      cr: money(e.credit),
      bal: drCr(e.balance),
    });
  }
  drawRow(
    {
      doc: 'Total / Closing balance',
      dr: formatNpr(s.totalDebit),
      cr: formatNpr(s.totalCredit),
      bal: drCr(s.closingBalance),
    },
    true,
  );
  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor('#555')
    .text('Dr = amount receivable from the party; Cr = amount payable to the party.', left)
    .fillColor('black');

  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#555')
      .text(
        `Generated ${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kathmandu' }).slice(0, 16)} NPT | Page ${p - range.start + 1} of ${range.count}`,
        left,
        PAGE.height - PAGE.margin - 12,
        { width: CONTENT_W, align: 'center', lineBreak: false },
      );
    doc.fillColor('black');
  }
  doc.end();
  return done;
}
