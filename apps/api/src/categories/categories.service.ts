import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction, type Category } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CategoryNodeDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/category.dto.js';

const DUPLICATE_NAME = 'A category with this name already exists';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async tree(
    actor: AuthUser,
    includeInactive = false,
  ): Promise<CategoryNodeDto[]> {
    const rows = await this.prisma.category.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: { name: 'asc' },
    });
    return buildTree(rows);
  }

  async findOne(actor: AuthUser, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async create(actor: AuthUser, dto: CreateCategoryDto) {
    if (dto.parentId) await this.findOne(actor, dto.parentId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const category = await tx.category.create({
          data: {
            tenantId: actor.tenantId,
            name: dto.name,
            parentId: dto.parentId,
          },
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Category',
            entityId: category.id,
            action: AuditAction.CREATE,
            newValue: category,
          },
          tx,
        );
        return category;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE_NAME);
      throw e;
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateCategoryDto) {
    const before = await this.findOne(actor, id);
    if (dto.parentId) await this.assertValidParent(actor, id, dto.parentId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const category = await tx.category.update({
          where: { id },
          data: {
            name: dto.name,
            parentId: dto.parentId,
            isActive: dto.isActive,
          },
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Category',
            entityId: id,
            action: AuditAction.UPDATE,
            oldValue: before,
            newValue: category,
          },
          tx,
        );
        return category;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE_NAME);
      throw e;
    }
  }

  // The new parent must exist in this tenant and must not be the category itself
  // or one of its descendants (that would create a loop).
  private async assertValidParent(
    actor: AuthUser,
    id: string,
    parentId: string,
  ) {
    if (parentId === id) {
      throw new BadRequestException('A category cannot be its own parent');
    }
    await this.findOne(actor, parentId);
    const all = await this.prisma.category.findMany({
      where: { tenantId: actor.tenantId },
      select: { id: true, parentId: true },
    });
    const parentOf = new Map(all.map((c) => [c.id, c.parentId]));
    for (
      let cur: string | null | undefined = parentId;
      cur;
      cur = parentOf.get(cur)
    ) {
      if (cur === id) {
        throw new BadRequestException(
          'A category cannot be moved under its own subcategory',
        );
      }
    }
  }
}

function buildTree(rows: Category[]): CategoryNodeDto[] {
  const nodes = new Map<string, CategoryNodeDto>(
    rows.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        isActive: c.isActive,
        children: [],
      },
    ]),
  );
  const roots: CategoryNodeDto[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    // A child whose parent is filtered out (inactive) is shown at the top level.
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}
