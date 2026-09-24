import { Prisma } from '../../generated/prisma/client.js';

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', belowHundred(n % 100)]
    .filter(Boolean)
    .join(' ');
}

/**
 * Whole number in the Nepali/Indian system: 1,20,000 -> "One Lakh Twenty Thousand".
 * Crores can themselves be large ("One Hundred Twenty Three Crore …").
 */
export function integerInWords(n: bigint): string {
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
export function amountInWords(
  amount: Prisma.Decimal | number | string,
): string {
  const value = new Prisma.Decimal(amount).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );
  if (value.lt(0)) return `Minus ${amountInWords(value.neg())}`;
  const rupees = BigInt(value.trunc().toFixed(0));
  const paisa = value.minus(value.trunc()).mul(100).toNumber();

  const parts = [`${integerInWords(rupees)} Rupees`];
  if (paisa) parts.push(`and ${belowHundred(paisa)} Paisa`);
  return `${parts.join(' ')} Only`;
}
