import { bsToAd, formatBS, getFiscalYear } from './nepali-date.js';

/** An instant at local Nepal noon on an AD date. */
const nepalNoon = (ad: string) => new Date(`${ad}T12:00:00+05:45`);

describe('Nepali date helpers', () => {
  it('converts AD to BS', () => {
    expect(formatBS(nepalNoon('2026-09-24'))).toBe('2083-06-08');
    expect(formatBS(nepalNoon('2026-04-14'))).toBe('2083-01-01'); // Nepali new year
  });

  it('converts BS to AD', () => {
    expect(bsToAd(2083, 4, 1)).toBe('2026-07-17'); // Shrawan 1, 2083
    expect(bsToAd(2083, 6, 8)).toBe('2026-09-24');
  });

  describe('fiscal year (starts Shrawan 1)', () => {
    const shrawan1 = bsToAd(2083, 4, 1); // 2026-07-17

    it('is the old year on the last day of Asar', () => {
      expect(formatBS(nepalNoon('2026-07-16'))).toBe('2083-03-32');
      expect(getFiscalYear(nepalNoon('2026-07-16'))).toBe('2082/83');
    });

    it('is the new year from Shrawan 1', () => {
      expect(getFiscalYear(nepalNoon(shrawan1))).toBe('2083/84');
      expect(getFiscalYear(nepalNoon('2026-09-24'))).toBe('2083/84');
    });

    it('uses the Nepal day, not UTC, around midnight', () => {
      // 00:10 in Nepal on Shrawan 1 is still 18:25 on the previous day in UTC.
      const justAfterMidnight = new Date(`${shrawan1}T00:10:00+05:45`);
      expect(justAfterMidnight.toISOString().slice(0, 10)).toBe('2026-07-16');
      expect(getFiscalYear(justAfterMidnight)).toBe('2083/84');
      // 23:50 Nepal on the last day of Asar is still the old year.
      expect(getFiscalYear(new Date('2026-07-16T23:50:00+05:45'))).toBe(
        '2082/83',
      );
    });

    it('handles months before Shrawan and later years', () => {
      expect(getFiscalYear(nepalNoon('2026-01-15'))).toBe('2082/83'); // Magh 2082
      // The converter's data ends at BS 2090, so 2089/90 is the last full year.
      expect(getFiscalYear(nepalNoon(bsToAd(2089, 5, 1)))).toBe('2089/90');
    });
  });
});
