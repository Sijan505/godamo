import { Decimal } from '../db.js';

export const VAT_RATE = new Decimal('0.13');
const round2 = (d) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Bill maths for purchases, orders and invoices. All amounts are rounded to 2 decimals (half up).
 * - subtotal = Σ line amounts
 * - the bill discount is spread over lines in proportion to their amount
 * - VAT (13%) is charged on the discounted amount of VAT-applicable lines only,
 *   computed on their combined taxable value like the supplier's bill
 * - total = subtotal − discount + VAT
 *
 * @param {Array<{ quantity: Decimal, rate: Decimal, discount: Decimal, vatApplicable: boolean }>} lines
 *   line discount is an amount (not %)
 * @param {Decimal} billDiscount
 * @returns {{
 *   lines: Array<{ amount: Decimal, billDiscountShare: Decimal, taxable: Decimal, vatAmount: Decimal }>,
 *   subtotal: Decimal, discount: Decimal, taxableAmount: Decimal, exemptAmount: Decimal,
 *   vatAmount: Decimal, total: Decimal }}
 */
export function calculateBill(lines, billDiscount) {
  const amounts = lines.map((l, i) => {
    const gross = l.quantity.mul(l.rate);
    if (l.discount.gt(gross)) {
      throw new RangeError(`Line ${i + 1}: discount is more than the line amount`);
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
    const share = subtotal.isZero() ? new Decimal(0) : round2(billDiscount.mul(amount).div(subtotal));
    discountLeft = discountLeft.minus(share);
    return share;
  });
  const taxables = amounts.map((a, i) => a.minus(shares[i]));

  const vatLines = lines.map((l, i) => (l.vatApplicable ? i : -1)).filter((i) => i >= 0);
  const vatableTotal = vatLines.reduce((s, i) => s.plus(taxables[i]), new Decimal(0));
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
    taxableAmount: vatableTotal,
    exemptAmount: subtotal.minus(billDiscount).minus(vatableTotal),
    vatAmount,
    total: subtotal.minus(billDiscount).plus(vatAmount),
  };
}

/** "1,20,000.50": Nepali/Indian digit grouping (last 3 digits, then pairs). */
export function formatNpr(amount) {
  const value = new Decimal(amount);
  const [whole, paisa] = value.abs().toFixed(2).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${value.lt(0) ? '-' : ''}${grouped}.${paisa}`;
}

// ─── Amount in words ────────────────────────────────────────────────────────

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
  if (n < 20) return ONES[n];
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}

function belowThousand(n) {
  const hundreds = Math.floor(n / 100);
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', belowHundred(n % 100)]
    .filter(Boolean)
    .join(' ');
}

/**
 * Whole number (BigInt) in the Nepali/Indian system: 1,20,000 -> "One Lakh Twenty Thousand".
 * Crores can themselves be large ("One Hundred Twenty Three Crore …").
 */
export function integerInWords(n) {
  if (n === 0n) return 'Zero';
  const crore = n / 10_000_000n;
  const rest = Number(n % 10_000_000n);
  const lakh = Math.floor(rest / 100_000);
  const thousand = Math.floor((rest % 100_000) / 1000);
  const below = rest % 1000;
  return [
    crore ? `${integerInWords(crore)} Crore` : '',
    lakh ? `${belowHundred(lakh)} Lakh` : '',
    thousand ? `${belowHundred(thousand)} Thousand` : '',
    below ? belowThousand(below) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Invoice amount in words, rounded to paisa:
 * 120000 -> "One Lakh Twenty Thousand Rupees Only"
 * 1250.5 -> "One Thousand Two Hundred Fifty Rupees and Fifty Paisa Only"
 */
export function amountInWords(amount) {
  const value = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (value.lt(0)) return `Minus ${amountInWords(value.neg())}`;
  const rupees = BigInt(value.trunc().toFixed(0));
  const paisa = value.minus(value.trunc()).mul(100).toNumber();

  const parts = [`${integerInWords(rupees)} Rupees`];
  if (paisa) parts.push(`and ${belowHundred(paisa)} Paisa`);
  return `${parts.join(' ')} Only`;
}
