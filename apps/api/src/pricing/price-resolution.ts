import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;

export type PriceSource = 'SPECIAL' | 'TIER' | 'DERIVED';

export interface PriceCandidates {
  /** Party's special price for this product + unit. */
  special?: Decimal | null;
  /** Party tier's price for this exact unit. */
  tierPrice?: Decimal | null;
  /** Party tier's price for the product's base unit (factor 1). */
  baseTierPrice?: Decimal | null;
  /** Base units in the requested unit. */
  unitFactor: Decimal;
}

/**
 * The price resolution order, used by billing and the field app:
 * 1) party special price  2) tier price for the unit
 * 3) tier base-unit price × unit factor  4) nothing (null).
 */
export function pickPrice(
  c: PriceCandidates,
): { price: Decimal; source: PriceSource } | null {
  if (c.special != null) return { price: c.special, source: 'SPECIAL' };
  if (c.tierPrice != null) return { price: c.tierPrice, source: 'TIER' };
  if (c.baseTierPrice != null) {
    return {
      price: c.baseTierPrice
        .mul(c.unitFactor)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      source: 'DERIVED',
    };
  }
  return null;
}
