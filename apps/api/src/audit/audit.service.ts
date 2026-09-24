import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  tenantId: string;
  userId: string;
  entity: string;
  entityId: string;
  action: AuditAction;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one audit row. Pass `tx` to write inside the caller's transaction so the
   * change and its audit row commit (or roll back) together. Never pass secrets.
   */
  async log(entry: AuditEntry, tx?: Prisma.TransactionClient) {
    await (tx ?? this.prisma).auditLog.create({ data: entry });
  }
}
