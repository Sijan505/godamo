import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

export const VAT_RATE = new Decimal('0.13');
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface PurchaseLineInput {
  quantity: Decimal;
  rate: Decimal;
  /** Line discount as an amount (not %). */
  discount: Decimal;
  vatApplicable: boolean;
}

export interface PurchaseLineTotals {
  /** quantity × rate − line discount, before VAT. */
  amount: Decimal;
  /** This line's share of the bill discount. */
  billDiscountShare: Decimal;
  /** amount − bill discount share: the value VAT is charged on. */
  taxable: Decimal;
  vatAmount: Decimal;
}

export interface PurchaseTotals {
  lines: PurchaseLineTotals[];
  subtotal: Decimal;
  discount: Decimal;
  vatAmount: Decimal;
  total: Decimal;
}

/**
 * Purchase bill maths. All amounts are rounded to 2 decimals (half up).
 * - subtotal = Σ line amounts
 * - the bill discount is spread over lines in proportion to their amount
 * - VAT (13%) is charged on the discounted amount of VAT-applicable lines only,
 *   computed on their combined taxable value like the supplier's bill
 * - total = subtotal − discount + VAT
 */
export function calculatePurchase(
  lines: PurchaseLineInput[],
  billDiscount: Decimal,
): PurchaseTotals {
  const amounts = lines.map((l, i) => {
    const gross = l.quantity.mul(l.rate);
    if (l.discount.gt(gross)) {
      throw new RangeError(
        `Line ${i + 1}: discount is more than the line amount`,
      );
    }
    return round2(gross.minus(l.discount));
  });
  const subtotal = amounts.reduce((s, a) => s.plus(a), new Decimal(0));
  if (billDiscount.gt(subtotal)) {
    throw new RangeError('Bill discount is more than the subtotal');
  }

  // Spread the bill discount; the last line takes the rounding remainder.
  let discountLeft = billDiscount;
  const shares = amounts.map((amount, i) => {
    if (i === amounts.length - 1) return discountLeft;
    const share = subtotal.isZero()
      ? new Decimal(0)
      : round2(billDiscount.mul(amount).div(subtotal));
    discountLeft = discountLeft.minus(share);
    return share;
  });
  const taxables = amounts.map((a, i) => a.minus(shares[i]));

  const vatLines = lines
    .map((l, i) => (l.vatApplicable ? i : -1))
    .filter((i) => i >= 0);
  const vatableTotal = vatLines.reduce(
    (s, i) => s.plus(taxables[i]),
    new Decimal(0),
  );
  const vatAmount = round2(vatableTotal.mul(VAT_RATE));

  // Per-line VAT for the record; the last VAT line absorbs rounding so the
  // lines always add up to the bill VAT.
  let vatLeft = vatAmount;
  const lineVat = lines.map((_, i) => {
    if (!vatLines.includes(i)) return new Decimal(0);
    if (i === vatLines[vatLines.length - 1]) return vatLeft;
    const v = round2(taxables[i].mul(VAT_RATE));
    vatLeft = vatLeft.minus(v);
    return v;
  });

  return {
    lines: amounts.map((amount, i) => ({
      amount,
      billDiscountShare: shares[i],
      taxable: taxables[i],
      vatAmount: lineVat[i],
    })),
    subtotal,
    discount: billDiscount,
    vatAmount,
    total: subtotal.minus(billDiscount).plus(vatAmount),
  };
}
