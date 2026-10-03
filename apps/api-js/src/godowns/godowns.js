import { auditLog } from '../common/audit.js';
import { AuditAction, UserRole, isUniqueViolation, prisma } from '../db.js';
import { BadRequest, Conflict, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  isBoolean,
  isString,
  length,
  optional,
  queryBoolean,
  schema,
  trim,
  validateIf,
} from '../http/validation.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const CreateGodownDto = schema({
  name: [trim(), isString(), length(1, 100)],
  address: [optional(), trim(), isString(), length(1, 300)],
});

const UpdateGodownDto = schema({
  name: [optional(), trim(), isString(), length(1, 100)],
  address: [validateIf((_, v) => v !== null && v !== undefined), trim(), isString(), length(1, 300)],
  /** true re-activates a deactivated godown */
  isActive: [optional(), isBoolean()],
});

const ListGodownsQueryDto = schema({
  includeInactive: [optional(), queryBoolean(), isBoolean()],
});

// ─── Service ────────────────────────────────────────────────────────────────

const DUPLICATE_NAME = 'A godown with this name already exists';

export function list(actor, includeInactive = false) {
  return prisma.godown.findMany({
    where: { tenantId: actor.tenantId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
}

export async function findOne(actor, id) {
  const godown = await prisma.godown.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!godown) throw NotFound('Godown not found');
  return godown;
}

/** An active godown of the caller's tenant, for use by stock documents. */
export async function getActiveGodown(actor, id, label = 'Godown') {
  const godown = await prisma.godown.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!godown) throw BadRequest(`${label} not found`);
  if (!godown.isActive) throw BadRequest(`${label} "${godown.name}" is inactive`);
  return godown;
}

export async function create(actor, dto) {
  try {
    return await prisma.$transaction(async (tx) => {
      const godown = await tx.godown.create({ data: { ...dto, tenantId: actor.tenantId } });
      await auditLog(
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
    if (isUniqueViolation(e)) throw Conflict(DUPLICATE_NAME);
    throw e;
  }
}

export async function update(actor, id, dto) {
  const before = await findOne(actor, id);
  if (dto.isActive === false && before.isActive) await assertEmpty(actor.tenantId, id);
  try {
    return await prisma.$transaction(async (tx) => {
      const godown = await tx.godown.update({ where: { id }, data: dto });
      await auditLog(
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
    if (isUniqueViolation(e)) throw Conflict(DUPLICATE_NAME);
    throw e;
  }
}

export function deactivate(actor, id) {
  return update(actor, id, { isActive: false });
}

// Stock can't be left stranded in an inactive godown.
async function assertEmpty(tenantId, godownId) {
  const rows = await prisma.$queryRaw`
    SELECT product_id FROM stock_movements
    WHERE tenant_id = ${tenantId} AND godown_id = ${godownId}
    GROUP BY product_id, batch_id
    HAVING SUM(quantity) <> 0
    LIMIT 1`;
  if (rows.length) {
    throw Conflict('This godown still has stock. Transfer or adjust it to zero before deactivating.');
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const MANAGERS = [UserRole.OWNER, UserRole.MANAGER];
const r = controller('/godowns');

r.get('/', { query: ListGodownsQueryDto }, ({ user, query }) => list(user, query.includeInactive));
r.get('/:id', { params: { id: 'uuid' } }, ({ user, params }) => findOne(user, params.id));
r.post('/', { roles: MANAGERS, body: CreateGodownDto }, ({ user, body }) => create(user, body));
r.patch('/:id', { roles: MANAGERS, params: { id: 'uuid' }, body: UpdateGodownDto }, ({ user, params, body }) =>
  update(user, params.id, body),
);
r.patch('/:id/deactivate', { roles: MANAGERS, params: { id: 'uuid' } }, ({ user, params }) =>
  deactivate(user, params.id),
);

export const godownsRoutes = r;
