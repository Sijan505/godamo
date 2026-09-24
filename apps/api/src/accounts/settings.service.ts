import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface TenantSettings {
  /** Days past the due date before an overdue invoice blocks new credit sales. */
  overdueGraceDays: number;
  blockOnOverdue: boolean;
}

export const DEFAULT_SETTINGS: TenantSettings = {
  overdueGraceDays: 7,
  blockOnOverdue: true,
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(db: Db, tenantId: string): Promise<TenantSettings> {
    const row = await db.tenantSetting.findUnique({ where: { tenantId } });
    return row
      ? {
          overdueGraceDays: row.overdueGraceDays,
          blockOnOverdue: row.blockOnOverdue,
        }
      : { ...DEFAULT_SETTINGS };
  }

  async update(actor: AuthUser, changes: Partial<TenantSettings>) {
    const before = await this.get(this.prisma, actor.tenantId);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.tenantSetting.upsert({
        where: { tenantId: actor.tenantId },
        create: { tenantId: actor.tenantId, ...before, ...changes },
        update: changes,
      });
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'TenantSetting',
          entityId: actor.tenantId,
          action: AuditAction.UPDATE,
          oldValue: before,
          newValue: changes,
        },
        tx,
      );
      return {
        overdueGraceDays: row.overdueGraceDays,
        blockOnOverdue: row.blockOnOverdue,
      };
    });
  }
}
