import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service.js';
import { AuthService, BCRYPT_ROUNDS } from '../auth/auth.service.js';
import type { AuthUser } from '../common/types/auth-user.js';
import { AuditAction, Prisma, UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateUserDto } from './dto/create-user.dto.js';
import type { ResetPasswordDto } from './dto/reset-password.dto.js';
import type { UpdateUserDto } from './dto/update-user.dto.js';

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
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  list(actor: AuthUser) {
    return this.prisma.user.findMany({
      where: { tenantId: actor.tenantId },
      select: USER_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async create(actor: AuthUser, dto: CreateUserDto) {
    if (dto.role === UserRole.OWNER && actor.role !== UserRole.OWNER) {
      throw new ForbiddenException('Only an owner can create another owner');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      return await this.prisma.$transaction(async (tx) => {
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
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            userId: actor.userId,
            entity: 'User',
            entityId: user.id,
            action: AuditAction.CREATE,
            newValue: {
              name: user.name,
              phone: user.phone,
              role: user.role,
              isActive: user.isActive,
            },
          },
          tx,
        );
        return user;
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'A user with this phone number already exists',
        );
      }
      throw e;
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto) {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.findInTenant(tx, actor, id);
      this.assertCanManage(actor, target.role);
      if (dto.role === UserRole.OWNER && actor.role !== UserRole.OWNER) {
        throw new ForbiddenException('Only an owner can make someone an owner');
      }
      if (id === actor.userId) {
        if (dto.isActive === false) {
          throw new BadRequestException('You cannot deactivate yourself');
        }
        if (dto.role !== undefined && dto.role !== target.role) {
          throw new BadRequestException('You cannot change your own role');
        }
      }

      const user = await tx.user.update({
        where: { id: target.id },
        data: { name: dto.name, role: dto.role, isActive: dto.isActive },
        select: USER_SELECT,
      });
      if (target.isActive && !user.isActive) {
        await this.auth.revokeAllForUser(user.id, tx);
      }

      const before = {
        name: target.name,
        role: target.role,
        isActive: target.isActive,
      };
      const after = {
        name: user.name,
        role: user.role,
        isActive: user.isActive,
      };
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          entity: 'User',
          entityId: user.id,
          action: AuditAction.UPDATE,
          oldValue: before,
          newValue: after,
        },
        tx,
      );
      return user;
    });
  }

  /** Sets a new password for a staff member and logs out all their sessions. */
  async resetPassword(actor: AuthUser, id: string, dto: ResetPasswordDto) {
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction(async (tx) => {
      const target = await this.findInTenant(tx, actor, id);
      this.assertCanManage(actor, target.role);
      await tx.user.update({
        where: { id: target.id },
        data: { passwordHash },
      });
      await this.auth.revokeAllForUser(target.id, tx);
      await this.audit.log(
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
  private async findInTenant(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    id: string,
  ) {
    const user = await tx.user.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private assertCanManage(actor: AuthUser, targetRole: UserRole) {
    if (targetRole === UserRole.OWNER && actor.role !== UserRole.OWNER) {
      throw new ForbiddenException('Only an owner can change an owner account');
    }
  }
}
