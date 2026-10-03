import { Decimal } from '../db.js';

/**
 * Writes a party ledger row (append-only). A party's balance is always
 * SUM(debit) - SUM(credit) and is never stored. Exactly one of debit / credit
 * must be a positive amount.
 * @param {{ tenantId: string, partyId: string, entryDate: Date, type: string,
 *   debit?: Decimal, credit?: Decimal, refType: string, refId: string, narration?: string }} entry
 */
export async function postLedger(tx, entry) {
  const debit = entry.debit ?? new Decimal(0);
  const credit = entry.credit ?? new Decimal(0);
  if (debit.lt(0) || credit.lt(0) || debit.gt(0) === credit.gt(0)) {
    throw new Error('A ledger entry needs exactly one positive debit or credit');
  }
  return tx.ledgerEntry.create({ data: { ...entry, debit, credit } });
}
