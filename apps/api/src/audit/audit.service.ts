import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  tenantId: string;
  userId: string;
  entity: string;
  entityId: string;
  action: AuditAction;
  /** Any JSON-serialisable value; Decimals and Dates are stored as strings. */
  oldValue?: unknown;
  newValue?: unknown;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one audit row. Pass `tx` to write inside the caller's transaction so the
   * change and its audit row commit (or roll back) together. Never pass secrets.
   */
  async log(entry: AuditEntry, tx?: Prisma.TransactionClient) {
    await (tx ?? this.prisma).auditLog.create({
      data: {
        ...entry,
        oldValue: toJson(entry.oldValue),
        newValue: toJson(entry.newValue),
      },
    });
  }
}

// Decimal and Date both implement toJSON, so a JSON round trip turns them into strings.
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value == null
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}
