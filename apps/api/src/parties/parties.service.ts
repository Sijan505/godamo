import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { pageArgs } from '../common/pagination.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction, PartyType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreatePartyDto,
  ListPartiesQueryDto,
  SpecialPriceItemDto,
  UpdatePartyDto,
} from './dto/party.dto.js';

// No balance here: it is derived from ledger_entries (a later step).
const PARTY_INCLUDE = {
  priceTier: { select: { id: true, name: true } },
  beat: { select: { id: true, name: true } },
} satisfies Prisma.PartyInclude;

@Injectable()
export class PartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthUser, q: ListPartiesQueryDto) {
    const where: Prisma.PartyWhereInput = {
      tenantId: actor.tenantId,
      beatId: q.beatId,
      priceTierId: q.priceTierId,
      isActive: q.isActive,
      // A BOTH party is a customer and a supplier.
      ...(q.type && {
        type:
          q.type === PartyType.BOTH ? q.type : { in: [q.type, PartyType.BOTH] },
      }),
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { phone: { contains: q.search } },
          { panVatNo: { contains: q.search } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.party.findMany({
        where,
        include: PARTY_INCLUDE,
        orderBy: { name: 'asc' },
        ...pageArgs(q),
      }),
      this.prisma.party.count({ where }),
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async findOne(actor: AuthUser, id: string) {
    const party = await this.prisma.party.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: PARTY_INCLUDE,
    });
    if (!party) throw new NotFoundException('Party not found');
    return party;
  }

  async create(actor: AuthUser, dto: CreatePartyDto) {
    await this.assertRefs(actor, dto.priceTierId, dto.beatId);
    return this.prisma.$transaction(async (tx) => {
      const party = await tx.party.create({
        data: { ...dto, tenantId: actor.tenantId },
        include: PARTY_INCLUDE,
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Party',
          entityId: party.id,
          action: AuditAction.CREATE,
          newValue: party,
        },
        tx,
      );
      return party;
    });
  }

  async update(actor: AuthUser, id: string, dto: UpdatePartyDto) {
    const before = await this.findOne(actor, id);
    await this.assertRefs(actor, dto.priceTierId, dto.beatId);
    return this.prisma.$transaction(async (tx) => {
      const party = await tx.party.update({
        where: { id },
        data: dto,
        include: PARTY_INCLUDE,
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'Party',
          entityId: id,
          action: AuditAction.UPDATE,
          oldValue: before,
          newValue: party,
        },
        tx,
      );
      return party;
    });
  }

  async deactivate(actor: AuthUser, id: string) {
    const before = await this.findOne(actor, id);
    if (!before.isActive) return before;
    return this.update(actor, id, { isActive: false });
  }

  // ─── Special prices ────────────────────────────────────────────────────────

  async listSpecialPrices(actor: AuthUser, partyId: string) {
    await this.findOne(actor, partyId);
    const rows = await this.prisma.partyPrice.findMany({
      where: { partyId, tenantId: actor.tenantId },
      include: {
        product: { select: { id: true, sku: true, name: true } },
        unit: { select: { id: true, name: true, factor: true } },
      },
      orderBy: { product: { name: 'asc' } },
    });
    return rows.map((r) => ({
      productId: r.productId,
      sku: r.product.sku,
      productName: r.product.name,
      unitId: r.unitId,
      unitName: r.unit.name,
      price: r.price.toFixed(2),
      updatedAt: r.updatedAt,
    }));
  }

  /** Upserts special prices for one party in one transaction; each change is audited. */
  async setSpecialPrices(
    actor: AuthUser,
    partyId: string,
    items: SpecialPriceItemDto[],
  ) {
    await this.findOne(actor, partyId);
    const products = await this.prisma.product.findMany({
      where: {
        tenantId: actor.tenantId,
        id: { in: [...new Set(items.map((i) => i.productId))] },
      },
      include: { units: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const errors: string[] = [];
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const product = productById.get(item.productId);
      if (!product) errors.push(`[${i}] product not found`);
      else if (!product.units.some((u) => u.id === item.unitId)) {
        errors.push(`[${i}] unitId is not a unit of this product`);
      }
      const key = `${item.productId}:${item.unitId}`;
      if (seen.has(key))
        errors.push(`[${i}] duplicate product + unit in the list`);
      seen.add(key);
    });
    if (errors.length) throw new BadRequestException(errors);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.partyPrice.findMany({ where: { partyId } });
      const byKey = new Map(
        existing.map((p) => [`${p.productId}:${p.unitId}`, p]),
      );
      for (const item of items) {
        const price = new Prisma.Decimal(item.price);
        const old = byKey.get(`${item.productId}:${item.unitId}`);
        if (old?.price.equals(price)) continue;

        await tx.partyPrice.upsert({
          where: {
            partyId_productId_unitId: {
              partyId,
              productId: item.productId,
              unitId: item.unitId,
            },
          },
          create: {
            tenantId: actor.tenantId,
            partyId,
            productId: item.productId,
            unitId: item.unitId,
            price,
          },
          update: { price },
        });
        const product = productById.get(item.productId)!;
        const label = {
          productId: product.id,
          sku: product.sku,
          unitId: item.unitId,
          unitName: product.units.find((u) => u.id === item.unitId)!.name,
        };
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'PartyPrice',
            entityId: partyId,
            action: old ? AuditAction.UPDATE : AuditAction.CREATE,
            oldValue: old
              ? { ...label, price: old.price.toFixed(2) }
              : undefined,
            newValue: { ...label, price: price.toFixed(2) },
          },
          tx,
        );
      }
    });
    return this.listSpecialPrices(actor, partyId);
  }

  /** Removes a special price so the party falls back to its tier price. */
  async removeSpecialPrice(
    actor: AuthUser,
    partyId: string,
    productId: string,
    unitId: string,
  ) {
    await this.findOne(actor, partyId);
    const row = await this.prisma.partyPrice.findFirst({
      where: { partyId, productId, unitId, tenantId: actor.tenantId },
      include: { product: true, unit: true },
    });
    if (!row)
      throw new NotFoundException('No special price for this product and unit');

    await this.prisma.$transaction(async (tx) => {
      await tx.partyPrice.delete({ where: { id: row.id } });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'PartyPrice',
          entityId: partyId,
          action: AuditAction.DELETE,
          oldValue: {
            productId,
            sku: row.product.sku,
            unitId,
            unitName: row.unit.name,
            price: row.price.toFixed(2),
          },
        },
        tx,
      );
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async assertRefs(
    actor: AuthUser,
    priceTierId?: string | null,
    beatId?: string | null,
  ) {
    if (priceTierId) {
      const tier = await this.prisma.priceTier.findFirst({
        where: { id: priceTierId, tenantId: actor.tenantId, isActive: true },
      });
      if (!tier) throw new BadRequestException('Price tier not found');
    }
    if (beatId) {
      const beat = await this.prisma.beat.findFirst({
        where: { id: beatId, tenantId: actor.tenantId },
      });
      if (!beat) throw new BadRequestException('Beat not found');
    }
  }
}
