import { after, before, describe, it } from 'node:test';
import { expect } from './expect.js';
import { Prisma } from '../src/db.js';
import { fromBase, toBase } from '../src/common/units.js';

const PCS_UNITS = [
  { name: 'pcs', factor: 1 },
  { name: 'box', factor: 12 },
  { name: 'carton', factor: 144 },
];

describe('toBase', () => {
  it('multiplies by the unit factor', () => {
    expect(toBase(5, 144).toString()).toBe('720');
    expect(toBase('3', '12').toString()).toBe('36');
  });

  it('handles zero', () => {
    expect(toBase(0, 144).isZero()).toBe(true);
  });

  it('keeps decimals exact (no float drift)', () => {
    // 0.1 * 3 in JS floats is 0.30000000000000004
    expect(toBase('0.1', 3).toString()).toBe('0.3');
    expect(toBase('2.5', '0.001').toString()).toBe('0.0025');
    expect(toBase(new Prisma.Decimal('1.333'), 3).toString()).toBe('3.999');
  });

  it('rejects zero or negative factors', () => {
    expect(() => toBase(1, 0)).toThrow(RangeError);
    expect(() => toBase(1, -12)).toThrow(RangeError);
  });
});

describe('fromBase', () => {
  it('breaks down using the largest units first', () => {
    const result = fromBase(173, PCS_UNITS);
    expect(result.text).toBe('1 carton 2 box 5 pcs');
    expect(result.parts.map((p) => [p.unitName, p.quantity.toNumber()])).toEqual([
      ['carton', 1],
      ['box', 2],
      ['pcs', 5],
    ]);
  });

  it('skips units with nothing in them', () => {
    expect(fromBase(149, PCS_UNITS).text).toBe('1 carton 5 pcs');
    expect(fromBase(288, PCS_UNITS).text).toBe('2 carton');
    expect(fromBase(7, PCS_UNITS).text).toBe('7 pcs');
  });

  it('does not depend on the order units are passed in', () => {
    expect(fromBase(173, [...PCS_UNITS].reverse()).text).toBe('1 carton 2 box 5 pcs');
  });

  it('returns "0 <base unit>" for zero', () => {
    const result = fromBase(0, PCS_UNITS);
    expect(result.text).toBe('0 pcs');
    expect(result.parts).toEqual([]);
  });

  it('keeps a decimal remainder in the smallest unit (kg)', () => {
    const units = [
      { name: 'kg', factor: 1 },
      { name: 'bag', factor: 25 },
    ];
    expect(fromBase('52.75', units).text).toBe('2 bag 2.75 kg');
    expect(fromBase('0.5', units).text).toBe('0.5 kg');
  });

  it('handles decimal factors exactly', () => {
    const units = [
      { name: 'kg', factor: '1' },
      { name: 'sack', factor: '50' },
    ];
    expect(fromBase('100.1', units).text).toBe('2 sack 0.1 kg');
  });

  it('shows negative stock with a leading minus', () => {
    expect(fromBase(-149, PCS_UNITS).text).toBe('-1 carton 5 pcs');
  });

  it('rejects an empty unit list or bad factors', () => {
    expect(() => fromBase(10, [])).toThrow(RangeError);
    expect(() => fromBase(10, [{ name: 'x', factor: 0 }])).toThrow(RangeError);
  });
});
