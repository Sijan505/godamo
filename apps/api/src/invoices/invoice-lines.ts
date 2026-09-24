import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const round2 = (d: Decimal) =>
  d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export interface LineMoney {
  /** In the sold unit. */
  quantity: Decimal;
  baseQty: Decimal;
  discount: Decimal;
  amount: Decimal;
  vatAmount: Decimal;
}

export interface BatchPart extends Omit<LineMoney, 'baseQty'> {
  batchId: string | null;
  baseQuantity: Decimal;
}

/**
 * An invoice line whose stock comes from several batches (FEFO) becomes one
 * invoice item per batch. Base quantities are exact; money and the unit
 * quantity are split in proportion, with the last part taking the rounding
 * remainder so the parts always add up to the original line.
 */
export function splitLineByBatches(
  line: LineMoney,
  allocations: { batchId: string | null; qty: Decimal }[],
): BatchPart[] {
  if (allocations.length === 1) {
    const { baseQty, ...money } = line;
    return [
      { ...money, batchId: allocations[0].batchId, baseQuantity: baseQty },
    ];
  }
  let left = {
    quantity: line.quantity,
    discount: line.discount,
    amount: line.amount,
    vatAmount: line.vatAmount,
  };
  return allocations.map((a, i) => {
    if (i === allocations.length - 1) {
      return { ...left, batchId: a.batchId, baseQuantity: a.qty };
    }
    const ratio = a.qty.div(line.baseQty);
    const part = {
      quantity: line.quantity
        .mul(ratio)
        .toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP),
      discount: round2(line.discount.mul(ratio)),
      amount: round2(line.amount.mul(ratio)),
      vatAmount: round2(line.vatAmount.mul(ratio)),
    };
    left = {
      quantity: left.quantity.minus(part.quantity),
      discount: left.discount.minus(part.discount),
      amount: left.amount.minus(part.amount),
      vatAmount: left.vatAmount.minus(part.vatAmount),
    };
    return { ...part, batchId: a.batchId, baseQuantity: a.qty };
  });
}
