import { Decimal } from '../db.js';

// All stock and quantity math goes through Decimal; never JS floats.

/** Converts a quantity in some unit to the product's base unit. */
export function toBase(quantity, unitFactor) {
  const factor = new Decimal(unitFactor);
  if (factor.lte(0)) throw new RangeError('Unit factor must be greater than 0');
  return new Decimal(quantity).mul(factor);
}

/**
 * Breaks a base quantity into the largest units first.
 * 173 pcs with carton=144, box=12 -> 1 carton, 2 box, 5 pcs.
 * Whole units are used for every unit except the smallest, which takes the
 * remainder (so 2.75 kg stays "2.75 kg").
 * @param {Array<{ name: string, factor: Decimal | number | string }>} units
 * @returns {{ parts: Array<{ unitName: string, quantity: Decimal }>, text: string }}
 */
export function fromBase(baseQty, units) {
  if (!units.length) throw new RangeError('At least one unit is required');
  const sorted = units
    .map((u) => ({ name: u.name, factor: new Decimal(u.factor) }))
    .sort((a, b) => b.factor.comparedTo(a.factor));
  if (sorted.some((u) => u.factor.lte(0))) {
    throw new RangeError('Unit factor must be greater than 0');
  }

  const total = new Decimal(baseQty);
  let remaining = total.abs();
  const parts = [];

  sorted.forEach((unit, i) => {
    const isSmallest = i === sorted.length - 1;
    const qty = isSmallest ? remaining.div(unit.factor) : remaining.divToInt(unit.factor);
    if (qty.isZero()) return;
    parts.push({ unitName: unit.name, quantity: qty });
    remaining = remaining.minus(qty.mul(unit.factor));
  });

  if (!parts.length) {
    const smallest = sorted[sorted.length - 1];
    return { parts: [], text: `0 ${smallest.name}` };
  }
  const text = parts.map((p) => `${p.quantity.toString()} ${p.unitName}`).join(' ');
  return { parts, text: total.lt(0) ? `-${text}` : text };
}
