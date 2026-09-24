import { Prisma } from '../generated/prisma/client.js';

export interface UnitRuleInput {
  name: string;
  factor: Prisma.Decimal | number | string;
  isDefaultSale?: boolean;
  isDefaultPurchase?: boolean;
}

/**
 * Checks a product's full unit set. Returns human-readable errors (empty = valid):
 * - every factor > 0 and unit names unique (case-insensitive)
 * - exactly one unit has factor 1, and it is the product's base unit
 * - exactly one default sale unit and exactly one default purchase unit
 */
export function validateUnitSet(
  baseUnit: string,
  units: UnitRuleInput[],
): string[] {
  const errors: string[] = [];
  if (!units.length) return ['At least one unit is required'];

  const factors = units.map((u) => new Prisma.Decimal(u.factor));
  if (factors.some((f) => f.lte(0))) {
    errors.push('Every unit factor must be greater than 0');
  }

  const names = units.map((u) => u.name.trim().toLowerCase());
  const duplicates = [
    ...new Set(names.filter((n, i) => names.indexOf(n) !== i)),
  ];
  if (duplicates.length) {
    errors.push(
      `Unit names must be unique (duplicate: ${duplicates.join(', ')})`,
    );
  }

  const baseUnits = units.filter((_, i) => factors[i].equals(1));
  if (baseUnits.length !== 1) {
    errors.push(
      `Exactly one unit must have factor 1 (the base unit), found ${baseUnits.length}`,
    );
  } else if (
    baseUnits[0].name.trim().toLowerCase() !== baseUnit.trim().toLowerCase()
  ) {
    errors.push(
      `The unit with factor 1 must be the base unit "${baseUnit}", not "${baseUnits[0].name}"`,
    );
  }

  const sale = units.filter((u) => u.isDefaultSale).length;
  if (sale !== 1) {
    errors.push(
      `Exactly one unit must be the default sale unit, found ${sale}`,
    );
  }
  const purchase = units.filter((u) => u.isDefaultPurchase).length;
  if (purchase !== 1) {
    errors.push(
      `Exactly one unit must be the default purchase unit, found ${purchase}`,
    );
  }
  return errors;
}
