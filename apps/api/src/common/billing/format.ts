import { Prisma } from '../../generated/prisma/client.js';

/** "1,20,000.50": Nepali/Indian digit grouping (last 3 digits, then pairs). */
export function formatNpr(amount: Prisma.Decimal | number | string): string {
  const value = new Prisma.Decimal(amount);
  const [whole, paisa] = value.abs().toFixed(2).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${value.lt(0) ? '-' : ''}${grouped}.${paisa}`;
}
