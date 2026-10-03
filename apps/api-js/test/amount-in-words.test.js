import { after, before, describe, it } from 'node:test';
import { expect } from './expect.js';
import { amountInWords, integerInWords } from '../src/common/billing.js';

describe('amountInWords (Nepali lakh/crore system)', () => {
  it('uses lakh, not hundred thousand', () => {
    expect(amountInWords(120000)).toBe('One Lakh Twenty Thousand Rupees Only');
  });

  it('uses crore for ten million and above', () => {
    expect(amountInWords('12345678.00')).toBe(
      'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only',
    );
    expect(integerInWords(1_000_000_000n)).toBe('One Hundred Crore');
  });

  it('adds paisa', () => {
    expect(amountInWords('1250.50')).toBe(
      'One Thousand Two Hundred Fifty Rupees and Fifty Paisa Only',
    );
    expect(amountInWords('0.05')).toBe('Zero Rupees and Five Paisa Only');
  });

  it('rounds to the nearest paisa', () => {
    expect(amountInWords('99.999')).toBe('One Hundred Rupees Only');
  });

  it('handles small and round numbers', () => {
    expect(amountInWords(0)).toBe('Zero Rupees Only');
    expect(amountInWords(15)).toBe('Fifteen Rupees Only');
    expect(amountInWords(100)).toBe('One Hundred Rupees Only');
    expect(amountInWords(1001)).toBe('One Thousand One Rupees Only');
    expect(amountInWords(9900000)).toBe('Ninety Nine Lakh Rupees Only');
  });
});
