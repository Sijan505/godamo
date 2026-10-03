import { dueDate } from '../accounts/accounts-rules.js';
import { partyBalance, unpaidInvoices } from '../accounts/outstanding.js';
import { auditLog } from '../common/audit.js';
import { formatNpr } from '../common/billing.js';
import { dateOnly as toDateOnly } from '../common/dates.js';
import { postLedger } from '../common/ledger.js';
import { formatBS } from '../common/nepali-date.js';
import { AuditAction, Decimal, LedgerEntryType, PaymentDirection, UserRole, prisma } from '../db.js';
import { Conflict, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import { dateOnly, isIn, isNumber, isPositive, max, optional, schema } from '../http/validation.js';
import { sendPdf } from '../invoices/invoices.js';
import { MAX_MONEY } from '../pricing/pricing.js';
import { renderLedgerPdf } from './ledger-pdf.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const OpeningBalanceDto = schema({
  amount: [isNumber({ maxDecimalPlaces: 2 }), isPositive(), max(MAX_MONEY)],
  /** RECEIVABLE: they owe us (debit). PAYABLE: we owe them (credit). */
  type: [isIn(['RECEIVABLE', 'PAYABLE'])],
  /** Usually the day before the fiscal year starts */
  asOfDate: [dateOnly()],
});

const LedgerQueryDto = schema({
  /** Entry date (AD) from, inclusive */
  from: [optional(), dateOnly()],
  /** Entry date (AD) to, inclusive */
  to: [optional(), dateOnly()],
});

// ─── Service ────────────────────────────────────────────────────────────────

export const OPENING_REF = 'OPENING';

/** One opening balance per party, as a single OPENING ledger row. */
export async function setOpeningBalance(actor, partyId, dto) {
  const party = await getParty(actor, partyId);
  const amount = new Decimal(dto.amount);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM parties WHERE id = ${party.id} FOR UPDATE`;
    const existing = await tx.ledgerEntry.findFirst({
      where: { tenantId: actor.tenantId, partyId, type: LedgerEntryType.OPENING },
    });
    if (existing) throw Conflict('This party already has an opening balance');
    await postLedger(tx, {
      tenantId: actor.tenantId,
      partyId,
      entryDate: toDateOnly(dto.asOfDate),
      type: LedgerEntryType.OPENING,
      ...(dto.type === 'RECEIVABLE' ? { debit: amount } : { credit: amount }),
      refType: OPENING_REF,
      refId: partyId,
      narration: `Opening balance (${dto.type.toLowerCase()})`,
    });
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'Party',
        entityId: partyId,
        action: AuditAction.CREATE,
        newValue: { openingBalance: amount, type: dto.type, asOfDate: dto.asOfDate },
      },
      tx,
    );
  });
  return statement(actor, partyId, {});
}

/** Opening balance at `from`, every entry with a running balance, closing balance. */
export async function statement(actor, partyId, q) {
  const party = await getParty(actor, partyId);
  const fromDate = q.from ? toDateOnly(q.from) : undefined;
  const toDate = q.to ? toDateOnly(q.to) : undefined;
  const base = { tenantId: actor.tenantId, partyId };

  const before = fromDate
    ? await prisma.ledgerEntry.aggregate({
        where: { ...base, entryDate: { lt: fromDate } },
        _sum: { debit: true, credit: true },
      })
    : null;
  const opening = before
    ? (before._sum.debit ?? new Decimal(0)).minus(before._sum.credit ?? new Decimal(0))
    : new Decimal(0);

  const entries = await prisma.ledgerEntry.findMany({
    where: {
      ...base,
      ...((fromDate || toDate) && {
        entryDate: { ...(fromDate && { gte: fromDate }), ...(toDate && { lte: toDate }) },
      }),
    },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const docNos = await documentNumbers(actor.tenantId, entries);

  let balance = opening;
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  const lines = entries.map((e) => {
    balance = balance.plus(e.debit).minus(e.credit);
    totalDebit = totalDebit.plus(e.debit);
    totalCredit = totalCredit.plus(e.credit);
    return {
      id: e.id,
      date: e.entryDate.toISOString().slice(0, 10),
      dateBs: formatBS(e.entryDate),
      type: e.type,
      documentNo: docNos.get(`${e.refType}:${e.refId}`) ?? null,
      refType: e.refType,
      refId: e.refId,
      narration: e.narration,
      debit: e.debit,
      credit: e.credit,
      balance,
    };
  });

  return {
    party: {
      id: party.id,
      name: party.name,
      type: party.type,
      address: party.address,
      panVatNo: party.panVatNo,
      phone: party.phone,
    },
    from: q.from ?? null,
    to: q.to ?? null,
    openingBalance: opening,
    totalDebit,
    totalCredit,
    closingBalance: balance,
    /** Dr = party owes us, Cr = we owe the party. */
    closingSide: balance.lt(0) ? 'Cr' : 'Dr',
    entries: lines,
  };
}

/** Polite payment reminder (Nepali + English) and a WhatsApp link. */
export async function reminder(actor, partyId) {
  const party = await getParty(actor, partyId);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } });
  const balance = await partyBalance(prisma, actor.tenantId, partyId);
  if (balance.lte(0)) {
    return { partyId, outstanding: balance.toFixed(2), message: null, whatsappUrl: null };
  }
  const unpaid = await unpaidInvoices(prisma, actor.tenantId, partyId);
  const oldest = unpaid[0];
  const amount = formatNpr(balance);

  let en = `Dear ${party.name}, this is a gentle reminder from ${tenant.name} that Rs ${amount} is outstanding on your account.`;
  let np = `नमस्ते ${party.name}, ${tenant.name} बाट विनम्र सम्झना: तपाईंको खातामा रु ${amount} बाँकी छ।`;
  if (oldest) {
    const due = dueDate(oldest.invoiceDate, oldest.creditDays);
    en += ` The oldest unpaid bill is invoice ${oldest.fiscalYear}-${oldest.invoiceNo} dated ${formatBS(oldest.invoiceDate)} BS (Rs ${formatNpr(oldest.outstanding)} due on ${formatBS(due)} BS).`;
    np += ` सबैभन्दा पुरानो बिल नं. ${oldest.fiscalYear}-${oldest.invoiceNo} (मिति ${formatBS(oldest.invoiceDate)}) को रु ${formatNpr(oldest.outstanding)} ${formatBS(due)} मा भुक्तानी गर्नुपर्ने थियो।`;
  }
  en += ' Kindly arrange the payment at your earliest convenience. Thank you.';
  np += ' कृपया सकेसम्म छिटो भुक्तानी गरिदिनुहोला। धन्यवाद।';

  const message = `${np}\n\n${en}`;
  const mobile = party.phone?.replace(/\D/g, '').replace(/^977/, '');
  const whatsappUrl =
    mobile && /^9[78]\d{8}$/.test(mobile)
      ? `https://wa.me/977${mobile}?text=${encodeURIComponent(message)}`
      : null;
  return {
    partyId,
    outstanding: balance.toFixed(2),
    oldestDueInvoice: oldest
      ? {
          invoiceId: oldest.invoiceId,
          invoiceNo: oldest.invoiceNo,
          fiscalYear: oldest.fiscalYear,
          invoiceDate: oldest.invoiceDate.toISOString().slice(0, 10),
          dueDate: dueDate(oldest.invoiceDate, oldest.creditDays).toISOString().slice(0, 10),
          outstanding: oldest.outstanding.toFixed(2),
        }
      : null,
    messageNepali: np,
    messageEnglish: en,
    message,
    whatsappUrl,
    ...(whatsappUrl ? {} : { whatsappNote: 'Party has no Nepali mobile number (97/98…)' }),
  };
}

// "INV 2083/84-12", "RC 2083/84-5", "PV 2083/84-2", "Bill HFS-0457"
async function documentNumbers(tenantId, entries) {
  const ids = (type) => [...new Set(entries.filter((e) => e.refType === type).map((e) => e.refId))];
  const [invoices, payments, purchases] = await Promise.all([
    prisma.invoice.findMany({
      where: { tenantId, id: { in: ids('INVOICE') } },
      select: { id: true, fiscalYear: true, invoiceNo: true },
    }),
    prisma.payment.findMany({
      where: { tenantId, id: { in: ids('PAYMENT') } },
      select: { id: true, fiscalYear: true, receiptNo: true, direction: true },
    }),
    prisma.purchase.findMany({
      where: { tenantId, id: { in: ids('PURCHASE') } },
      select: { id: true, supplierBillNo: true },
    }),
  ]);
  const map = new Map();
  for (const i of invoices) map.set(`INVOICE:${i.id}`, `INV ${i.fiscalYear}-${i.invoiceNo}`);
  for (const p of payments) {
    const prefix = p.direction === PaymentDirection.IN ? 'RC' : 'PV';
    map.set(`PAYMENT:${p.id}`, `${prefix} ${p.fiscalYear}-${p.receiptNo}`);
  }
  for (const p of purchases) map.set(`PURCHASE:${p.id}`, `Bill ${p.supplierBillNo}`);
  for (const e of entries) {
    if (e.refType === OPENING_REF) map.set(`${e.refType}:${e.refId}`, 'Opening');
  }
  return map;
}

async function getParty(actor, partyId) {
  const party = await prisma.party.findFirst({ where: { id: partyId, tenantId: actor.tenantId } });
  if (!party) throw NotFound('Party not found');
  return party;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const { OWNER, MANAGER, OFFICE, SALESMAN } = UserRole;
const READERS = [OWNER, MANAGER, OFFICE, SALESMAN];
const r = controller('/parties');

// Set the opening balance (owner only, once per party)
r.post(
  '/:id/opening-balance',
  { roles: [OWNER], params: { id: 'uuid' }, body: OpeningBalanceDto },
  ({ user, params, body }) => setOpeningBalance(user, params.id, body),
);
// Ledger statement: opening, entries with BS dates and running balance, closing
r.get('/:id/ledger', { roles: READERS, params: { id: 'uuid' }, query: LedgerQueryDto }, ({ user, params, query }) =>
  statement(user, params.id, query),
);
r.get(
  '/:id/ledger/pdf',
  { roles: READERS, params: { id: 'uuid' }, query: LedgerQueryDto },
  async ({ user, params, query, res }) => {
    const [s, tenant] = await Promise.all([
      statement(user, params.id, query),
      prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } }),
    ]);
    sendPdf(res, await renderLedgerPdf(s, tenant), `ledger-${s.party.name.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`);
  },
);
// Payment reminder text (Nepali + English) and a WhatsApp link
r.get('/:id/reminder', { roles: READERS, params: { id: 'uuid' } }, ({ user, params }) =>
  reminder(user, params.id),
);

export const partyAccountsRoutes = r;
