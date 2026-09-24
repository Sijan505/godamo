import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { dueDate } from '../accounts/accounts-rules.js';
import { OutstandingService } from '../accounts/outstanding.service.js';
import { AuditService } from '../audit/audit.service.js';
import { formatNpr } from '../common/billing/format.js';
import { dateOnly } from '../common/dates.js';
import { formatBS } from '../common/nepali-date/nepali-date.js';
import type { AuthUser } from '../common/types/auth-user.js';
import {
  AuditAction,
  LedgerEntryType,
  PaymentDirection,
  Prisma,
} from '../generated/prisma/client.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  LedgerQueryDto,
  OpeningBalanceDto,
} from './party-accounts.dto.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;
export const OPENING_REF = 'OPENING';

@Injectable()
export class PartyAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly outstanding: OutstandingService,
  ) {}

  /** One opening balance per party, as a single OPENING ledger row. */
  async setOpeningBalance(
    actor: AuthUser,
    partyId: string,
    dto: OpeningBalanceDto,
  ) {
    const party = await this.getParty(actor, partyId);
    const amount = new Decimal(dto.amount);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM parties WHERE id = ${party.id} FOR UPDATE`;
      const existing = await tx.ledgerEntry.findFirst({
        where: {
          tenantId: actor.tenantId,
          partyId,
          type: LedgerEntryType.OPENING,
        },
      });
      if (existing) {
        throw new ConflictException(
          'This party already has an opening balance',
        );
      }
      await this.ledger.post(tx, {
        tenantId: actor.tenantId,
        partyId,
        entryDate: dateOnly(dto.asOfDate),
        type: LedgerEntryType.OPENING,
        ...(dto.type === 'RECEIVABLE' ? { debit: amount } : { credit: amount }),
        refType: OPENING_REF,
        refId: partyId,
        narration: `Opening balance (${dto.type.toLowerCase()})`,
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Party',
          entityId: partyId,
          action: AuditAction.CREATE,
          newValue: {
            openingBalance: amount,
            type: dto.type,
            asOfDate: dto.asOfDate,
          },
        },
        tx,
      );
    });
    return this.statement(actor, partyId, {});
  }

  /** Opening balance at `from`, every entry with a running balance, closing balance. */
  async statement(actor: AuthUser, partyId: string, q: LedgerQueryDto) {
    const party = await this.getParty(actor, partyId);
    const fromDate = q.from ? dateOnly(q.from) : undefined;
    const toDate = q.to ? dateOnly(q.to) : undefined;
    const base = { tenantId: actor.tenantId, partyId };

    const before = fromDate
      ? await this.prisma.ledgerEntry.aggregate({
          where: { ...base, entryDate: { lt: fromDate } },
          _sum: { debit: true, credit: true },
        })
      : null;
    const opening = before
      ? (before._sum.debit ?? new Decimal(0)).minus(
          before._sum.credit ?? new Decimal(0),
        )
      : new Decimal(0);

    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        ...base,
        ...((fromDate || toDate) && {
          entryDate: {
            ...(fromDate && { gte: fromDate }),
            ...(toDate && { lte: toDate }),
          },
        }),
      },
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const docNos = await this.documentNumbers(actor.tenantId, entries);

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
  async reminder(actor: AuthUser, partyId: string) {
    const party = await this.getParty(actor, partyId);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
    });
    const balance = await this.outstanding.partyBalance(
      this.prisma,
      actor.tenantId,
      partyId,
    );
    if (balance.lte(0)) {
      return {
        partyId,
        outstanding: balance.toFixed(2),
        message: null,
        whatsappUrl: null,
      };
    }
    const unpaid = await this.outstanding.unpaidInvoices(
      this.prisma,
      actor.tenantId,
      partyId,
    );
    const oldest = unpaid[0];
    const amount = formatNpr(balance);

    let en = `Dear ${party.name}, this is a gentle reminder from ${tenant.name} that Rs ${amount} is outstanding on your account.`;
    let np = `नमस्ते ${party.name}, ${tenant.name} बाट विनम्र सम्झना: तपाईंको खातामा रु ${amount} बाँकी छ।`;
    if (oldest) {
      const due = dueDate(oldest.invoiceDate, oldest.creditDays);
      en += ` The oldest unpaid bill is invoice ${oldest.fiscalYear}-${oldest.invoiceNo} dated ${formatBS(oldest.invoiceDate)} BS (Rs ${formatNpr(oldest.outstanding)} due on ${formatBS(due)} BS).`;
      np += ` सबैभन्दा पुरानो बिल नं. ${oldest.fiscalYear}-${oldest.invoiceNo} (मिति ${formatBS(oldest.invoiceDate)}) को रु ${formatNpr(oldest.outstanding)} ${formatBS(due)} मा भुक्तानी गर्नुपर्ने थियो।`;
    }
    en +=
      ' Kindly arrange the payment at your earliest convenience. Thank you.';
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
            dueDate: dueDate(oldest.invoiceDate, oldest.creditDays)
              .toISOString()
              .slice(0, 10),
            outstanding: oldest.outstanding.toFixed(2),
          }
        : null,
      messageNepali: np,
      messageEnglish: en,
      message,
      whatsappUrl,
      ...(whatsappUrl
        ? {}
        : { whatsappNote: 'Party has no Nepali mobile number (97/98…)' }),
    };
  }

  async tenant(actor: AuthUser) {
    return this.prisma.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
    });
  }

  // "INV 2083/84-12", "RC 2083/84-5", "PV 2083/84-2", "Bill HFS-0457"
  private async documentNumbers(
    tenantId: string,
    entries: { refType: string; refId: string }[],
  ) {
    const ids = (type: string) => [
      ...new Set(entries.filter((e) => e.refType === type).map((e) => e.refId)),
    ];
    const [invoices, payments, purchases] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { tenantId, id: { in: ids('INVOICE') } },
        select: { id: true, fiscalYear: true, invoiceNo: true },
      }),
      this.prisma.payment.findMany({
        where: { tenantId, id: { in: ids('PAYMENT') } },
        select: {
          id: true,
          fiscalYear: true,
          receiptNo: true,
          direction: true,
        },
      }),
      this.prisma.purchase.findMany({
        where: { tenantId, id: { in: ids('PURCHASE') } },
        select: { id: true, supplierBillNo: true },
      }),
    ]);
    const map = new Map<string, string>();
    for (const i of invoices)
      map.set(`INVOICE:${i.id}`, `INV ${i.fiscalYear}-${i.invoiceNo}`);
    for (const p of payments) {
      const prefix = p.direction === PaymentDirection.IN ? 'RC' : 'PV';
      map.set(`PAYMENT:${p.id}`, `${prefix} ${p.fiscalYear}-${p.receiptNo}`);
    }
    for (const p of purchases)
      map.set(`PURCHASE:${p.id}`, `Bill ${p.supplierBillNo}`);
    for (const e of entries) {
      if (e.refType === OPENING_REF)
        map.set(`${e.refType}:${e.refId}`, 'Opening');
    }
    return map;
  }

  private async getParty(actor: AuthUser, partyId: string) {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId: actor.tenantId },
    });
    if (!party) throw new NotFoundException('Party not found');
    return party;
  }
}

export type LedgerStatement = Awaited<
  ReturnType<PartyAccountsService['statement']>
>;
