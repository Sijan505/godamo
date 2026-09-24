import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateGodownDto, UpdateGodownDto } from './godowns.dto.js';

const DUPLICATE_NAME = 'A godown with this name already exists';

@Injectable()
export class GodownsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(actor: AuthUser, includeInactive = false) {
    return this.prisma.godown.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(actor: AuthUser, id: string) {
    const godown = await this.prisma.godown.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!godown) throw new NotFoundException('Godown not found');
    return godown;
  }

  /** An active godown of the caller's tenant, for use by stock documents. */
  async getActive(actor: AuthUser, id: string, label = 'Godown') {
    const godown = await this.prisma.godown.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!godown) throw new BadRequestException(`${label} not found`);
    if (!godown.isActive) {
      throw new BadRequestException(`${label} "${godown.name}" is inactive`);
    }
    return godown;
  }

  async create(actor: AuthUser, dto: CreateGodownDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const godown = await tx.godown.create({
          data: { ...dto, tenantId: actor.tenantId },
        });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Godown',
            entityId: godown.id,
            action: AuditAction.CREATE,
            newValue: godown,
          },
          tx,
        );
        return godown;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE_NAME);
      throw e;
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateGodownDto) {
    const before = await this.findOne(actor, id);
    if (dto.isActive === false && before.isActive) {
      await this.assertEmpty(actor.tenantId, id);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const godown = await tx.godown.update({ where: { id }, data: dto });
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'Godown',
            entityId: id,
            action: AuditAction.UPDATE,
            oldValue: before,
            newValue: godown,
          },
          tx,
        );
        return godown;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(DUPLICATE_NAME);
      throw e;
    }
  }

  deactivate(actor: AuthUser, id: string) {
    return this.update(actor, id, { isActive: false });
  }

  // Stock can't be left stranded in an inactive godown.
  private async assertEmpty(tenantId: string, godownId: string) {
    const rows = await this.prisma.$queryRaw<{ product_id: string }[]>`
      SELECT product_id FROM stock_movements
      WHERE tenant_id = ${tenantId} AND godown_id = ${godownId}
      GROUP BY product_id, batch_id
      HAVING SUM(quantity) <> 0
      LIMIT 1`;
    if (rows.length) {
      throw new ConflictException(
        'This godown still has stock. Transfer or adjust it to zero before deactivating.',
      );
    }
  }
}
