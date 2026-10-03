import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS, revokeAllForUser } from '../auth/auth.js';
import { auditLog } from '../common/audit.js';
import { NEPALI_MOBILE_MESSAGE, NEPALI_MOBILE_REGEX, PASSWORD_MAX_LENGTH } from '../common/roles.js';
import { AuditAction, Prisma, UserRole, prisma } from '../db.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../http/errors.js';
import { controller } from '../http/router.js';
import {
  isBoolean,
  isEnum,
  isString,
  length,
  matches,
  optional,
  schema,
  trim,
} from '../http/validation.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const CreateUserDto = schema({
  name: [trim(), isString(), length(2, 100)],
  phone: [trim(), matches(NEPALI_MOBILE_REGEX, NEPALI_MOBILE_MESSAGE)],
  role: [isEnum(UserRole)],
  password: [isString(), length(8, PASSWORD_MAX_LENGTH)],
});

const UpdateUserDto = schema({
  name: [optional(), trim(), isString(), length(2, 100)],
  role: [optional(), isEnum(UserRole)],
  /** false deactivates the user and logs out all their sessions */
  isActive: [optional(), isBoolean()],
});

const ResetPasswordDto = schema({
  newPassword: [isString(), length(8, PASSWORD_MAX_LENGTH)],
});

// ─── Service ────────────────────────────────────────────────────────────────

// Never select passwordHash.
const USER_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
};

export function list(actor) {
  return prisma.user.findMany({
    where: { tenantId: actor.tenantId },
    select: USER_SELECT,
    orderBy: { name: 'asc' },
  });
}

export async function create(actor, dto) {
  if (dto.role === UserRole.OWNER && actor.role !== UserRole.OWNER) {
    throw Forbidden('Only an owner can create another owner');
  }
  const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: actor.tenantId,
          name: dto.name,
          phone: dto.phone,
          role: dto.role,
          passwordHash,
        },
        select: USER_SELECT,
      });
      await auditLog(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'User',
          entityId: user.id,
          action: AuditAction.CREATE,
          newValue: { name: user.name, phone: user.phone, role: user.role, isActive: user.isActive },
        },
        tx,
      );
      return user;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw Conflict('A user with this phone number already exists');
    }
    throw e;
  }
}

export async function update(actor, id, dto) {
  return prisma.$transaction(async (tx) => {
    const target = await findInTenant(tx, actor, id);
    assertCanManage(actor, target.role);
    if (dto.role === UserRole.OWNER && actor.role !== UserRole.OWNER) {
      throw Forbidden('Only an owner can make someone an owner');
    }
    if (id === actor.userId) {
      if (dto.isActive === false) throw BadRequest('You cannot deactivate yourself');
      if (dto.role !== undefined && dto.role !== target.role) {
        throw BadRequest('You cannot change your own role');
      }
    }

    const user = await tx.user.update({
      where: { id: target.id },
      data: { name: dto.name, role: dto.role, isActive: dto.isActive },
      select: USER_SELECT,
    });
    if (target.isActive && !user.isActive) await revokeAllForUser(user.id, tx);

    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'User',
        entityId: user.id,
        action: AuditAction.UPDATE,
        oldValue: { name: target.name, role: target.role, isActive: target.isActive },
        newValue: { name: user.name, role: user.role, isActive: user.isActive },
      },
      tx,
    );
    return user;
  });
}

/** Sets a new password for a staff member and logs out all their sessions. */
export async function resetPassword(actor, id, dto) {
  const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
  await prisma.$transaction(async (tx) => {
    const target = await findInTenant(tx, actor, id);
    assertCanManage(actor, target.role);
    await tx.user.update({ where: { id: target.id }, data: { passwordHash } });
    await revokeAllForUser(target.id, tx);
    await auditLog(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        entity: 'User',
        entityId: target.id,
        action: AuditAction.UPDATE,
        newValue: { passwordReset: true },
      },
      tx,
    );
  });
}

// A user id from another tenant is indistinguishable from one that doesn't exist.
async function findInTenant(tx, actor, id) {
  const user = await tx.user.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!user) throw NotFound('User not found');
  return user;
}

function assertCanManage(actor, targetRole) {
  if (targetRole === UserRole.OWNER && actor.role !== UserRole.OWNER) {
    throw Forbidden('Only an owner can change an owner account');
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Only OWNER and MANAGER can manage users.
const r = controller('/users', { roles: [UserRole.OWNER, UserRole.MANAGER] });

r.get('/', ({ user }) => list(user));
r.post('/', { body: CreateUserDto }, ({ user, body }) => create(user, body));
r.patch('/:id', { params: { id: 'uuid' }, body: UpdateUserDto }, ({ user, params, body }) =>
  update(user, params.id, body),
);
r.post(
  '/:id/reset-password',
  { status: 204, params: { id: 'uuid' }, body: ResetPasswordDto },
  ({ user, params, body }) => resetPassword(user, params.id, body),
);

export const usersRoutes = r;
