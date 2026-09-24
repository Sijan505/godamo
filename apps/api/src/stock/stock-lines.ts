import { BadRequestException } from '@nestjs/common';
import { toBase } from '../common/units/unit-conversion.js';
import { Prisma } from '../generated/prisma/client.js';

type Db = Prisma.TransactionClient;
export type ProductWithUnits = Prisma.ProductGetPayload<{
  include: { units: true };
}>;

/** Loads the caller's products (with units) by id; throws if any is missing. */
export async function loadProducts(
  db: Db,
  tenantId: string,
  ids: string[],
): Promise<Map<string, ProductWithUnits>> {
  const products = await db.product.findMany({
    where: { tenantId, id: { in: [...new Set(ids)] } },
    include: { units: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const missing = ids.find((id) => !byId.has(id));
  if (missing) throw new BadRequestException(`Product ${missing} not found`);
  return byId;
}

/** The unit of `product` with this id; throws a 400 if it belongs elsewhere. */
export function unitOf(product: ProductWithUnits, unitId: string) {
  const unit = product.units.find((u) => u.id === unitId);
  if (!unit) {
    throw new BadRequestException(
      `Unit ${unitId} is not a unit of ${product.name}`,
    );
  }
  return unit;
}

/**
 * quantity (in a unit) -> BASE units. Base quantities are stored with 3 decimals,
 * so anything finer is rejected instead of silently rounded.
 */
export function baseQuantity(
  product: ProductWithUnits,
  unitId: string,
  quantity: number | Prisma.Decimal,
): Prisma.Decimal {
  const base = toBase(quantity, unitOf(product, unitId).factor);
  if (base.decimalPlaces() > 3) {
    throw new BadRequestException(
      `${product.name}: ${quantity.toString()} ${unitOf(product, unitId).name} is ` +
        `${base.toString()} ${product.baseUnit}, more precise than 0.001`,
    );
  }
  return base;
}

/** Checks a batch belongs to the product. */
export async function assertBatch(
  db: Db,
  tenantId: string,
  product: ProductWithUnits,
  batchId: string,
) {
  const batch = await db.batch.findFirst({
    where: { id: batchId, tenantId, productId: product.id },
  });
  if (!batch) {
    throw new BadRequestException(
      `Batch ${batchId} is not a batch of ${product.name}`,
    );
  }
  return batch;
}
