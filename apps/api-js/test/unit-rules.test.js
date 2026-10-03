import { after, before, describe, it } from 'node:test';
import { expect } from './expect.js';
import { validateUnitSet } from '../src/products/products.js';

const valid = [
  { name: 'pcs', factor: 1 },
  { name: 'box', factor: 12, isDefaultSale: true },
  { name: 'carton', factor: 144, isDefaultPurchase: true },
];

describe('validateUnitSet', () => {
  it('accepts a valid unit set', () => {
    expect(validateUnitSet('pcs', valid)).toEqual([]);
  });

  it('accepts a single base unit that is both defaults', () => {
    expect(
      validateUnitSet('kg', [
        { name: 'kg', factor: 1, isDefaultSale: true, isDefaultPurchase: true },
      ]),
    ).toEqual([]);
  });

  it('requires exactly one factor-1 unit matching the base unit', () => {
    expect(
      validateUnitSet('pcs', [
        {
          name: 'box',
          factor: 12,
          isDefaultSale: true,
          isDefaultPurchase: true,
        },
      ]),
    ).toContain('Exactly one unit must have factor 1 (the base unit), found 0');
    expect(
      validateUnitSet('pcs', [
        {
          name: 'piece',
          factor: 1,
          isDefaultSale: true,
          isDefaultPurchase: true,
        },
      ]),
    ).toContain('The unit with factor 1 must be the base unit "pcs", not "piece"');
  });

  it('rejects zero/negative factors and duplicate names', () => {
    const errors = validateUnitSet('pcs', [...valid, { name: 'Box', factor: 0 }]);
    expect(errors).toContain('Every unit factor must be greater than 0');
    expect(errors).toContain('Unit names must be unique (duplicate: box)');
  });

  it('requires exactly one default sale and purchase unit', () => {
    const errors = validateUnitSet('pcs', [
      { name: 'pcs', factor: 1, isDefaultSale: true },
      { name: 'box', factor: 12, isDefaultSale: true },
    ]);
    expect(errors).toContain('Exactly one unit must be the default sale unit, found 2');
    expect(errors).toContain('Exactly one unit must be the default purchase unit, found 0');
  });
});
