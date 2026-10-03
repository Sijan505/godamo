import { prisma } from '../db.js';

/**
 * Writes one audit row. Pass `tx` to write inside the caller's transaction so the
 * change and its audit row commit (or roll back) together. Never pass secrets.
 * @param {{ tenantId: string, userId: string, entity: string, entityId: string,
 *   action: string, oldValue?: unknown, newValue?: unknown }} entry
 */
export async function auditLog(entry, tx) {
  await (tx ?? prisma).auditLog.create({
    data: {
      ...entry,
      oldValue: toJson(entry.oldValue),
      newValue: toJson(entry.newValue),
    },
  });
}

// Decimal and Date both implement toJSON, so a JSON round trip turns them into strings.
function toJson(value) {
  return value == null ? undefined : JSON.parse(JSON.stringify(value));
}
