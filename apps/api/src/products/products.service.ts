import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { pageArgs } from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction, Prisma } from '../generated/prisma/client.js';
import { PricingService } from '../pricing/pricing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateProductDto,
  CreateUnitDto,
  ListProductsQueryDto,
  UpdateProductDto,
  UpdateUnitDto,
} from './dto/product.dto.js';
import { validateUnitSet } from './unit-rules.js';

const LIST_INCLUDE = {
  category: { select: { id: true, name: true } },
  units: { orderBy: { factor: 'asc' } },
} satisfies Prisma.ProductInclude;

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
  ) {}

  async list(actor: AuthUser, q: ListProductsQueryDto) {
    const where: Prisma.ProductWhereInput = {
      tenantId: actor.tenantId,
      categoryId: q.categoryId,
      isActive: q.isActive,
      ...(q.brand && { brand: { equals: q.brand, mode: 'insensitive' } }),
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { nameNepali: { contains: q.search, mode: 'insensitive' } },
          { sku: { contains: q.search, mode: 'insensitive' } },
          { barcode: q.search },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { name: 'asc' },
        ...pageArgs(q),
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  /** Product with category, units (smallest first) and all tier prices. */
  async findOne(actor: AuthUser, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: LIST_INCLUDE,
    });
    if (!product) throw new NotFoundException('Product not found');
    return this.withPrices(product);
  }

  async findByBarcode(actor: AuthUser, code: string) {
    const product = await this.prisma.product.findFirst({
      where: { tenantId: actor.tenantId, barcode: code },
      include: LIST_INCLUDE,
    });
    if (!product) {
      throw new NotFoundException('No product with this barcode');
    }
    return this.withPrices(product);
  }

  async create(actor: AuthUser, dto: CreateProductDto) {
    const unitErrors = validateUnitSet(dto.baseUnit, dto.units);
    if (unitErrors.length) throw new BadRequestException(unitErrors);
    await this.assertCategory(actor, dto.categoryId);
    await this.assertUniqueCodes(actor.tenantId, dto.sku, dto.barcode);

    const { units, ...fields } = dto;
    try {
      const product = await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            ...fields,
            tenantId: actor.tenantId,
            units: {
              create: units.map((u) => ({
                tenantId: actor.tenantId,
                name: u.name,
                factor: u.factor,
                isDefaultSale: !!u.isDefaultSale,
                isDefaultPurchase: !!u.isDefaultPurchase,
              })),
            },
          },
          include: LIST_INCLUDE,
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Product',
            entityId: created.id,
            action: AuditAction.CREATE,
            newValue: created,
          },
          tx,
        );
        return created;
      });
      return this.withPrices(product);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('SKU or barcode is already in use');
      }
      throw e;
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateProductDto) {
    const before = await this.getOwned(actor, id);
    if (dto.categoryId) await this.assertCategory(actor, dto.categoryId);
    await this.assertUniqueCodes(actor.tenantId, dto.sku, dto.barcode, id);

    try {
      await this.prisma.$transaction(async (tx) => {
        const after = await tx.product.update({ where: { id }, data: dto });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Product',
            entityId: id,
            action: AuditAction.UPDATE,
            oldValue: before,
            newValue: after,
          },
          tx,
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('SKU or barcode is already in use');
      }
      throw e;
    }
    return this.findOne(actor, id);
  }

  async deactivate(actor: AuthUser, id: string) {
    const before = await this.getOwned(actor, id);
    if (before.isActive) {
      await this.prisma.$transaction(async (tx) => {
        await tx.product.update({ where: { id }, data: { isActive: false } });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Product',
            entityId: id,
            action: AuditAction.UPDATE,
            oldValue: { isActive: true },
            newValue: { isActive: false },
          },
          tx,
        );
      });
    }
    return this.findOne(actor, id);
  }

  // ─── Units ─────────────────────────────────────────────────────────────────

  async addUnit(actor: AuthUser, productId: string, dto: CreateUnitDto) {
    const product = await this.getOwned(actor, productId, true);
    // Check the whole set as it would look after adding this unit.
    const next = [
      ...product.units.map((u) => ({
        name: u.name,
        factor: u.factor,
        isDefaultSale: dto.isDefaultSale ? false : u.isDefaultSale,
        isDefaultPurchase: dto.isDefaultPurchase ? false : u.isDefaultPurchase,
      })),
      dto,
    ];
    const errors = validateUnitSet(product.baseUnit, next);
    if (errors.length) throw new BadRequestException(errors);

    await this.prisma.$transaction(async (tx) => {
      await this.clearDefaults(tx, productId, dto);
      const unit = await tx.productUnit.create({
        data: {
          tenantId: actor.tenantId,
          productId,
          name: dto.name,
          factor: dto.factor,
          isDefaultSale: !!dto.isDefaultSale,
          isDefaultPurchase: !!dto.isDefaultPurchase,
        },
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'ProductUnit',
          entityId: unit.id,
          action: AuditAction.CREATE,
          newValue: unit,
        },
        tx,
      );
    });
    return this.findOne(actor, productId);
  }

  async updateUnit(
    actor: AuthUser,
    productId: string,
    unitId: string,
    dto: UpdateUnitDto,
  ) {
    const product = await this.getOwned(actor, productId, true);
    const unit = product.units.find((u) => u.id === unitId);
    if (!unit) throw new NotFoundException('Unit not found for this product');
    const isBase = unit.factor.equals(1);

    if (dto.name !== undefined && dto.name !== unit.name) {
      if (isBase) {
        throw new BadRequestException(
          'The base unit cannot be renamed; it must match the product base unit',
        );
      }
      if (product.units.some((u) => u.id !== unitId && u.name === dto.name)) {
        throw new ConflictException(
          `This product already has a unit named "${dto.name}"`,
        );
      }
    }

    if (dto.factor !== undefined && !unit.factor.equals(dto.factor)) {
      if (isBase) {
        throw new BadRequestException('The base unit factor must stay 1');
      }
      if (new Prisma.Decimal(dto.factor).equals(1)) {
        throw new BadRequestException('Only the base unit can have factor 1');
      }
      if (await this.isUnitUsed(this.prisma, unitId)) {
        throw new ConflictException(
          `Unit "${unit.name}" is already used in purchases, orders, invoices or returns, ` +
            'so its factor cannot be changed. Add a new unit with the new factor instead.',
        );
      }
    }

    if (
      (dto.isDefaultSale === false && unit.isDefaultSale) ||
      (dto.isDefaultPurchase === false && unit.isDefaultPurchase)
    ) {
      throw new BadRequestException(
        'A product always needs a default unit. Set another unit as the default instead.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.clearDefaults(tx, productId, dto);
      const after = await tx.productUnit.update({
        where: { id: unitId },
        data: {
          name: dto.name,
          factor: dto.factor,
          isDefaultSale: dto.isDefaultSale || undefined,
          isDefaultPurchase: dto.isDefaultPurchase || undefined,
        },
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'ProductUnit',
          entityId: unitId,
          action: AuditAction.UPDATE,
          oldValue: unit,
          newValue: after,
        },
        tx,
      );
    });
    return this.findOne(actor, productId);
  }

  /** True if any purchase, order, invoice or return line uses this unit. */
  async isUnitUsed(db: Db, unitId: string): Promise<boolean> {
    const counts = await Promise.all([
      db.purchaseItem.count({ where: { unitId } }),
      db.salesOrderItem.count({ where: { unitId } }),
      db.invoiceItem.count({ where: { unitId } }),
      db.salesReturnItem.count({ where: { unitId } }),
    ]);
    return counts.some((c) => c > 0);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async getOwned(actor: AuthUser, id: string, withUnits = false) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: { units: withUnits },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async withPrices<T extends { id: string; tenantId: string }>(
    product: T,
  ) {
    return {
      ...product,
      prices: await this.pricing.getProductPrices(product.tenantId, product.id),
    };
  }

  private async assertCategory(actor: AuthUser, categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, tenantId: actor.tenantId },
    });
    if (!category) throw new BadRequestException('Category not found');
  }

  private async assertUniqueCodes(
    tenantId: string,
    sku?: string,
    barcode?: string | null,
    excludeId?: string,
  ) {
    const not = excludeId ? { id: { not: excludeId } } : {};
    if (sku) {
      const clash = await this.prisma.product.findFirst({
        where: { tenantId, sku, ...not },
        select: { id: true },
      });
      if (clash) throw new ConflictException(`SKU "${sku}" is already in use`);
    }
    if (barcode) {
      const clash = await this.prisma.product.findFirst({
        where: { tenantId, barcode, ...not },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(`Barcode "${barcode}" is already in use`);
      }
    }
  }

  // Setting a new default sale/purchase unit unsets the old one.
  private async clearDefaults(
    tx: Prisma.TransactionClient,
    productId: string,
    flags: { isDefaultSale?: boolean; isDefaultPurchase?: boolean },
  ) {
    if (flags.isDefaultSale) {
      await tx.productUnit.updateMany({
        where: { productId },
        data: { isDefaultSale: false },
      });
    }
    if (flags.isDefaultPurchase) {
      await tx.productUnit.updateMany({
        where: { productId },
        data: { isDefaultPurchase: false },
      });
    }
  }
}
