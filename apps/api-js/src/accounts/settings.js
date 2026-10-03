import { auditLog } from '../common/audit.js';
import { AuditAction, UserRole, prisma } from '../db.js';
import { controller } from '../http/router.js';
import { isBoolean, isInt, max, min, optional, schema } from '../http/validation.js';

const UpdateSettingsDto = schema({
  /** Days past due before overdue bills block credit sales */
  overdueGraceDays: [optional(), isInt(), min(0), max(365)],
  blockOnOverdue: [optional(), isBoolean()],
});

/**
 * Credit-control settings: overdueGraceDays is how many days past the due date
 * before an overdue invoice blocks new credit sales.
 */
export const DEFAULT_SETTINGS = { overdueGraceDays: 7, blockOnOverdue: true };

/** @returns {Promise<{ overdueGraceDays: number, blockOnOverdue: boolean }>} */
export async function getSettings(db, tenantId) {
  const row = await db.tenantSetting.findUnique({ where: { tenantId } });
  return row
    ? { overdueGraceDays: row.overdueGraceDays, blockOnOverdue: row.blockOnOverdue }
    : { ...DEFAULT_SETTINGS };
}

export async function updateSettings(actor, changes) {
  const before = await getSettings(prisma, actor.tenantId);
  return prisma.$transaction(async (tx) => {
    const row = await tx.tenantSetting.upsert({
      where: { tenantId: actor.tenantId },
      create: { tenantId: actor.tenantId, ...before, ...changes },
      update: changes,
    });
    await auditLog(
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
    return { overdueGraceDays: row.overdueGraceDays, blockOnOverdue: row.blockOnOverdue };
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const r = controller('/settings');

r.get('/', { roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE] }, ({ user }) =>
  getSettings(prisma, user.tenantId),
);
// Credit-control settings (owner only)
r.patch('/', { roles: [UserRole.OWNER], body: UpdateSettingsDto }, ({ user, body }) =>
  updateSettings(user, body),
);

export const settingsRoutes = r;
