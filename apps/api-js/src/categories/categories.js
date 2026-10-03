import { auditLog } from '../common/audit.js';
import { MASTER_DATA_WRITE_ROLES } from '../common/roles.js';
import { AuditAction, isUniqueViolation, prisma } from '../db.js';
import { BadRequest, Conflict, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  isBoolean,
  isString,
  isUuid,
  length,
  optional,
  queryBoolean,
  schema,
  trim,
  validateIf,
} from '../http/validation.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const CreateCategoryDto = schema({
  name: [trim(), isString(), length(1, 100)],
  /** Parent category id; omit for a top-level category */
  parentId: [optional(), isUuid()],
});

const UpdateCategoryDto = schema({
  name: [optional(), trim(), isString(), length(1, 100)],
  /** null moves the category to the top level */
  parentId: [validateIf((_, v) => v !== null && v !== undefined), isUuid()],
  /** false deactivates the category */
  isActive: [optional(), isBoolean()],
});

const CategoryTreeQueryDto = schema({
  includeInactive: [optional(), queryBoolean(), isBoolean()],
});

// ─── Service ────────────────────────────────────────────────────────────────

const DUPLICATE_NAME = 'A category with this name already exists';

export async function tree(actor, includeInactive = false) {
  const rows = await prisma.category.findMany({
    where: { tenantId: actor.tenantId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
  return buildTree(rows);
}

export async function findOne(actor, id) {
  const category = await prisma.category.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!category) throw NotFound('Category not found');
  return category;
}

export async function create(actor, dto) {
  if (dto.parentId) await findOne(actor, dto.parentId);
  try {
    return await prisma.$transaction(async (tx) => {
      const category = await tx.category.create({
        data: { tenantId: actor.tenantId, name: dto.name, parentId: dto.parentId },
      });
      await auditLog(
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
    if (isUniqueViolation(e)) throw Conflict(DUPLICATE_NAME);
    throw e;
  }
}

export async function update(actor, id, dto) {
  const before = await findOne(actor, id);
  if (dto.parentId) await assertValidParent(actor, id, dto.parentId);

  try {
    return await prisma.$transaction(async (tx) => {
      const category = await tx.category.update({
        where: { id },
        data: { name: dto.name, parentId: dto.parentId, isActive: dto.isActive },
      });
      await auditLog(
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
    if (isUniqueViolation(e)) throw Conflict(DUPLICATE_NAME);
    throw e;
  }
}

// The new parent must exist in this tenant and must not be the category itself
// or one of its descendants (that would create a loop).
async function assertValidParent(actor, id, parentId) {
  if (parentId === id) throw BadRequest('A category cannot be its own parent');
  await findOne(actor, parentId);
  const all = await prisma.category.findMany({
    where: { tenantId: actor.tenantId },
    select: { id: true, parentId: true },
  });
  const parentOf = new Map(all.map((c) => [c.id, c.parentId]));
  for (let cur = parentId; cur; cur = parentOf.get(cur)) {
    if (cur === id) throw BadRequest('A category cannot be moved under its own subcategory');
  }
}

function buildTree(rows) {
  const nodes = new Map(
    rows.map((c) => [
      c.id,
      { id: c.id, name: c.name, parentId: c.parentId, isActive: c.isActive, children: [] },
    ]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    // A child whose parent is filtered out (inactive) is shown at the top level.
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const r = controller('/categories');

r.get('/', { query: CategoryTreeQueryDto }, ({ user, query }) => tree(user, query.includeInactive));
r.get('/:id', { params: { id: 'uuid' } }, ({ user, params }) => findOne(user, params.id));
r.post('/', { roles: MASTER_DATA_WRITE_ROLES, body: CreateCategoryDto }, ({ user, body }) =>
  create(user, body),
);
r.patch(
  '/:id',
  { roles: MASTER_DATA_WRITE_ROLES, params: { id: 'uuid' }, body: UpdateCategoryDto },
  ({ user, params, body }) => update(user, params.id, body),
);

export const categoriesRoutes = r;
