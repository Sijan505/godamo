/**
 * Builds priced sale lines for orders and invoices. The server ALWAYS works out
 * rates (via pricing), discounts, VAT and totals itself.
 */
import { calculateBill } from '../common/billing.js';
import { Decimal, PartyType, UserRole, prisma } from '../db.js';
import { BadRequest, HttpError } from '../http/errors.js';
import { resolveMany } from '../pricing/pricing.js';
import { baseQuantity, loadProducts, unitOf } from '../stock/stock-lines.js';

/**
 * Most a SALESMAN may discount one line, in percent.
 * TODO: make this a per-tenant setting.
 */
export const SALESMAN_MAX_DISCOUNT_PERCENT = new Decimal(5);

/** The party must be an active customer (or BOTH) of this tenant. */
export async function getCustomer(actor, partyId) {
  const party = await prisma.party.findFirst({ where: { id: partyId, tenantId: actor.tenantId } });
  if (!party) throw BadRequest('Party not found');
  if (party.type === PartyType.SUPPLIER) throw BadRequest(`${party.name} is not a customer`);
  if (!party.isActive) throw BadRequest(`${party.name} is inactive`);
  return party;
}

/**
 * @param {Array<{ productId: string, unitId: string, quantity: number | Decimal,
 *   discountPercent?: number | Decimal }>} items
 * @returns {Promise<{ lines: Array<{ lineNo: number, product: object, unitId: string,
 *   unitName: string, factor: Decimal, quantity: Decimal, baseQty: Decimal, rate: Decimal,
 *   priceSource: string, discountPercent: Decimal, discount: Decimal }>,
 *   totals: ReturnType<typeof calculateBill> }>}
 *   rate is resolved by pricing, never taken from the client; discount is
 *   quantity × rate × discountPercent / 100, rounded to paisa.
 */
export async function priceSale(actor, partyId, items, billDiscount = new Decimal(0)) {
  if (!items.length) throw BadRequest('Add at least one item');
  const products = await loadProducts(
    prisma,
    actor.tenantId,
    items.map((i) => i.productId),
  );
  items.forEach((item, i) => {
    const product = products.get(item.productId);
    if (!product.isActive) throw BadRequest(`Item ${i + 1}: ${product.name} is inactive`);
    unitOf(product, item.unitId);
    const pct = new Decimal(item.discountPercent ?? 0);
    if (actor.role === UserRole.SALESMAN && pct.gt(SALESMAN_MAX_DISCOUNT_PERCENT)) {
      throw BadRequest(
        `Item ${i + 1}: salesmen can give at most ${SALESMAN_MAX_DISCOUNT_PERCENT.toString()}% discount per line`,
      );
    }
  });

  const resolved = await resolveMany(
    actor,
    partyId,
    items.map((i) => ({ productId: i.productId, unitId: i.unitId })),
  );
  const unpriced = resolved.map((r, i) => ({ item: i + 1, ...r })).filter((r) => r.error);
  if (unpriced.length) {
    throw new HttpError(422, {
      statusCode: 422,
      code: 'NO_PRICE',
      message: 'Some items have no price for this party',
      items: unpriced.map((r) => ({
        item: r.item,
        productId: r.productId,
        unitId: r.unitId,
        error: r.error,
      })),
    });
  }

  const lines = items.map((item, i) => {
    const product = products.get(item.productId);
    const unit = unitOf(product, item.unitId);
    const quantity = new Decimal(item.quantity);
    const rate = new Decimal(resolved[i].price);
    const discountPercent = new Decimal(item.discountPercent ?? 0);
    return {
      lineNo: i + 1,
      product,
      unitId: unit.id,
      unitName: unit.name,
      factor: unit.factor,
      quantity,
      baseQty: baseQuantity(product, unit.id, quantity),
      rate,
      priceSource: resolved[i].source,
      discountPercent,
      discount: quantity.mul(rate).mul(discountPercent).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    };
  });

  try {
    const totals = calculateBill(
      lines.map((l) => ({
        quantity: l.quantity,
        rate: l.rate,
        discount: l.discount,
        vatApplicable: l.product.vatApplicable,
      })),
      billDiscount,
    );
    return { lines, totals };
  } catch (e) {
    if (e instanceof RangeError) throw BadRequest(e.message);
    throw e;
  }
}
