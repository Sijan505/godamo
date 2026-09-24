import { Injectable } from '@nestjs/common';
import { LedgerEntryType, Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;

export interface LedgerEntryInput {
  tenantId: string;
  partyId: string;
  entryDate: Date;
  type: LedgerEntryType;
  /** Exactly one of debit / credit must be a positive amount. */
  debit?: Decimal;
  credit?: Decimal;
  refType: string;
  refId: string;
  narration?: string;
}

/**
 * Writes party ledger rows (append-only). A party's balance is always
 * SUM(debit) - SUM(credit) and is never stored.
 */
@Injectable()
export class LedgerService {
  async post(tx: Prisma.TransactionClient, entry: LedgerEntryInput) {
    const debit = entry.debit ?? new Prisma.Decimal(0);
    const credit = entry.credit ?? new Prisma.Decimal(0);
    if (debit.lt(0) || credit.lt(0) || debit.gt(0) === credit.gt(0)) {
      throw new Error(
        'A ledger entry needs exactly one positive debit or credit',
      );
    }
    return tx.ledgerEntry.create({ data: { ...entry, debit, credit } });
  }
}
