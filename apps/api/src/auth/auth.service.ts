import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { createHmac, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type {
  AccessTokenPayload,
  AuthUser,
} from '../common/types/auth-user.js';
import { AuditAction, Prisma, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';

export const INVALID_LOGIN_MESSAGE = 'Invalid company code, phone or password';
const INVALID_REFRESH_MESSAGE = 'Invalid or expired refresh token';
export const BCRYPT_ROUNDS = 10;

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class AuthService {
  private readonly refreshSecret: string;
  private readonly refreshTtlMs: number;
  // Compared against when the company or phone doesn't exist, so every failed
  // login costs one bcrypt compare and response time doesn't reveal which part was wrong.
  private readonly dummyHash = bcrypt.hashSync(
    'godamo-timing-guard',
    BCRYPT_ROUNDS,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.refreshTtlMs =
      Number(config.getOrThrow<string>('JWT_REFRESH_EXPIRES_DAYS')) *
      24 *
      60 *
      60 *
      1000;
  }

  async login(dto: LoginDto, userAgent?: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { code: dto.companyCode },
    });
    const user = tenant
      ? await this.prisma.user.findUnique({
          where: { tenantId_phone: { tenantId: tenant.id, phone: dto.phone } },
        })
      : null;
    const passwordOk = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? this.dummyHash,
    );

    if (!tenant?.isActive || !user?.isActive || !passwordOk) {
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    const tokens = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      return this.issueTokens(user, tx, userAgent);
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        tenantId: tenant.id,
        tenantName: tenant.name,
      },
    };
  }

  /** Rotates a refresh token: the presented one is revoked and a new pair is issued. */
  async refresh(rawToken: string, userAgent?: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(rawToken) },
      include: { user: { include: { tenant: true } } },
    });
    if (!stored || stored.expiresAt <= new Date()) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
    if (stored.revokedAt) {
      // An already-rotated token is being replayed, so it has probably leaked.
      // End every session for this user; they must log in again.
      await this.revokeAllForUser(stored.userId);
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
    const { user } = stored;
    if (!user.isActive || !user.tenant.isActive) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional update so two concurrent refreshes with the same token can't both win.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
      return this.issueTokens(user, tx, userAgent);
    });
  }

  /** Revokes one refresh token, if it belongs to the caller. Always succeeds silently. */
  async logout(current: AuthUser, rawToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash: this.hashToken(rawToken),
        userId: current.userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  async me(current: AuthUser) {
    const user = await this.prisma.user.findFirst({
      where: { id: current.userId, tenantId: current.tenantId },
      include: { tenant: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      lastLoginAt: user.lastLoginAt,
      tenantId: user.tenantId,
      tenantName: user.tenant.name,
      tenantCode: user.tenant.code,
    };
  }

  /** Changes the caller's password and logs out all their sessions. */
  async changePassword(current: AuthUser, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { id: current.userId, tenantId: current.tenantId },
    });
    if (
      !user ||
      !(await bcrypt.compare(dto.currentPassword, user.passwordHash))
    ) {
      throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await this.revokeAllForUser(user.id, tx);
      await this.audit.log(
        {
          tenantId: current.tenantId,
          userId: current.userId,
          entity: 'User',
          entityId: user.id,
          action: AuditAction.UPDATE,
          newValue: { passwordChanged: true },
        },
        tx,
      );
    });
  }

  async revokeAllForUser(userId: string, db: Db = this.prisma) {
    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(
    user: Pick<User, 'id' | 'tenantId' | 'role'>,
    db: Db,
    userAgent?: string,
  ) {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
    };
    const accessToken = await this.jwt.signAsync(payload);

    const refreshToken = randomBytes(48).toString('base64url');
    await db.refreshToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
        userAgent: userAgent?.slice(0, 255),
      },
    });

    return { accessToken, refreshToken };
  }

  // Refresh tokens are 384 random bits, so a keyed SHA-256 is enough (and, unlike
  // bcrypt, lets us look the token up by its hash). The raw token is never stored.
  private hashToken(rawToken: string) {
    return createHmac('sha256', this.refreshSecret)
      .update(rawToken)
      .digest('hex');
  }
}
