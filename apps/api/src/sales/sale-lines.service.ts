import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type BillTotals,
  calculateBill,
} from '../common/billing/bill-totals.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { PartyType, Prisma, UserRole } from '../generated/prisma/client.js';
import { PricingService } from '../pricing/pricing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  baseQuantity,
  loadProducts,
  type ProductWithUnits,
  unitOf,
} from '../stock/stock-lines.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/**
 * Most a SALESMAN may discount one line, in percent.
 * TODO: make this a per-tenant setting.
 */
export const SALESMAN_MAX_DISCOUNT_PERCENT = new Decimal(5);

export interface SaleItemInput {
  productId: string;
  unitId: string;
  quantity: number | Decimal;
  discountPercent?: number | Decimal;
}

export interface SaleLine {
  lineNo: number;
  product: ProductWithUnits;
  unitId: string;
  unitName: string;
  factor: Decimal;
  quantity: Decimal;
  baseQty: Decimal;
  /** Resolved by PricingService, never taken from the client. */
  rate: Decimal;
  priceSource: string;
  discountPercent: Decimal;
  /** quantity × rate × discountPercent / 100, rounded to paisa. */
  discount: Decimal;
}

export interface PricedSale {
  lines: SaleLine[];
  totals: BillTotals;
}

/**
 * Builds priced sale lines for orders and invoices. The server ALWAYS works out
 * rates (via PricingService), discounts, VAT and totals itself.
 */
@Injectable()
export class SaleLinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  /** The party must be an active customer (or BOTH) of this tenant. */
  async getCustomer(actor: AuthUser, partyId: string) {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId: actor.tenantId },
    });
    if (!party) throw new BadRequestException('Party not found');
    if (party.type === PartyType.SUPPLIER) {
      throw new BadRequestException(`${party.name} is not a customer`);
    }
    if (!party.isActive) {
      throw new BadRequestException(`${party.name} is inactive`);
    }
    return party;
  }

  async price(
    actor: AuthUser,
    partyId: string,
    items: SaleItemInput[],
    billDiscount: Decimal = new Decimal(0),
  ): Promise<PricedSale> {
    if (!items.length) throw new BadRequestException('Add at least one item');
    const products = await loadProducts(
      this.prisma,
      actor.tenantId,
      items.map((i) => i.productId),
    );
    items.forEach((item, i) => {
      const product = products.get(item.productId)!;
      if (!product.isActive) {
        throw new BadRequestException(
          `Item ${i + 1}: ${product.name} is inactive`,
        );
      }
      unitOf(product, item.unitId);
      const pct = new Decimal(item.discountPercent ?? 0);
      if (
        actor.role === UserRole.SALESMAN &&
        pct.gt(SALESMAN_MAX_DISCOUNT_PERCENT)
      ) {
        throw new BadRequestException(
          `Item ${i + 1}: salesmen can give at most ${SALESMAN_MAX_DISCOUNT_PERCENT.toString()}% discount per line`,
        );
      }
    });

    const resolved = await this.pricing.resolveMany(
      actor,
      partyId,
      items.map((i) => ({ productId: i.productId, unitId: i.unitId })),
    );
    const unpriced = resolved
      .map((r, i) => ({ item: i + 1, ...r }))
      .filter((r) => r.error);
    if (unpriced.length) {
      throw new UnprocessableEntityException({
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

    const lines: SaleLine[] = items.map((item, i) => {
      const product = products.get(item.productId)!;
      const unit = unitOf(product, item.unitId);
      const quantity = new Decimal(item.quantity);
      const rate = new Decimal(resolved[i].price!);
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
        priceSource: resolved[i].source!,
        discountPercent,
        discount: quantity
          .mul(rate)
          .mul(discountPercent)
          .div(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
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
      if (e instanceof RangeError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
