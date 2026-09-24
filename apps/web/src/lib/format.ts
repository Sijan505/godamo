/**
 * Money in the Nepali style: "Rs. 12,34,567.00" (last three digits, then
 * groups of two). Works on the decimal string the API sends, so no float
 * rounding ever touches an amount.
 */
export function formatNPR(
  value: string | number | null | undefined,
  { symbol = true }: { symbol?: boolean } = {},
): string {
  const digits = groupNepali(value);
  return symbol ? `Rs. ${digits}` : digits;
}

/** "12,34,567.00" (no currency symbol). */
export function groupNepali(value: string | number | null | undefined): string {
  let text = value === null || value === undefined || value === "" ? "0" : String(value).trim();
  if (typeof value === "number") text = value.toFixed(2);

  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  const [wholeRaw, fractionRaw = ""] = text.split(".");
  const cents = roundCents(wholeRaw.replace(/^0+(?=\d)/, "") || "0", fractionRaw);

  const whole = cents.whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  const isZero = /^0+$/.test(whole) && cents.fraction === "00";
  return `${negative && !isZero ? "-" : ""}${grouped}.${cents.fraction}`;
}

/** Rounds a decimal string to 2 places (half up) using string arithmetic. */
function roundCents(whole: string, fraction: string): { whole: string; fraction: string } {
  const padded = (fraction + "000").slice(0, 3);
  let cents = parseInt(padded.slice(0, 2), 10);
  let carry = 0;
  if (parseInt(padded[2], 10) >= 5) cents += 1;
  if (cents === 100) {
    cents = 0;
    carry = 1;
  }
  let outWhole = whole;
  if (carry) {
    const d = whole.split("").map(Number);
    let i = d.length - 1;
    while (i >= 0) {
      if (d[i] === 9) {
        d[i] = 0;
        i--;
      } else {
        d[i] += 1;
        break;
      }
    }
    outWhole = (i < 0 ? "1" : "") + d.join("");
  }
  return { whole: outWhole, fraction: String(cents).padStart(2, "0") };
}

/** Compact axis label: 1,250,000 -> "12.5L", 25,000 -> "25K". */
export function compactNPR(value: number): string {
  if (Math.abs(value) >= 10_000_000) return `${+(value / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(value) >= 100_000) return `${+(value / 100_000).toFixed(1)}L`;
  if (Math.abs(value) >= 1000) return `${+(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function toNumber(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : parseFloat(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}
