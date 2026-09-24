import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import type { AuditService } from '../audit/audit.service.js';
import { UserRole } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuthService, INVALID_LOGIN_MESSAGE } from './auth.service.js';

const ACCESS_SECRET = 'test-access-secret';

const tenant = {
  id: 'tenant-1',
  code: 'DEMO',
  name: 'Demo Distributors',
  isActive: true,
};

function makePrisma() {
  const prisma = {
    tenant: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    refreshToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    // Run the transaction callback against the same mock.
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return prisma;
}

describe('AuthService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let jwt: JwtService;
  let service: AuthService;
  let user: {
    id: string;
    tenantId: string;
    name: string;
    phone: string;
    role: UserRole;
    isActive: boolean;
    passwordHash: string;
  };

  beforeAll(async () => {
    user = {
      id: 'user-1',
      tenantId: tenant.id,
      name: 'Demo Owner',
      phone: '9800000000',
      role: UserRole.OWNER,
      isActive: true,
      passwordHash: await bcrypt.hash('admin123', 4),
    };
  });

  beforeEach(() => {
    prisma = makePrisma();
    jwt = new JwtService({
      secret: ACCESS_SECRET,
      signOptions: { expiresIn: '15m' },
    });
    const config = new ConfigService({
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      JWT_REFRESH_EXPIRES_DAYS: '30',
    });
    const audit = { log: vi.fn() } as unknown as AuditService;
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt,
      audit,
      config,
    );
  });

  describe('login', () => {
    const dto = {
      companyCode: 'DEMO',
      phone: '9800000000',
      password: 'admin123',
    };

    it('returns tokens and the user profile for valid credentials', async () => {
      prisma.tenant.findUnique.mockResolvedValue(tenant);
      prisma.user.findUnique.mockResolvedValue(user);

      const result = await service.login(dto, 'vitest');

      expect(result.user).toEqual({
        id: user.id,
        name: user.name,
        role: UserRole.OWNER,
        tenantId: tenant.id,
        tenantName: tenant.name,
      });
      const payload = await jwt.verifyAsync(result.accessToken);
      expect(payload).toMatchObject({
        sub: user.id,
        tenantId: tenant.id,
        role: UserRole.OWNER,
      });

      // The refresh token is stored only as a hash.
      expect(result.refreshToken).toEqual(expect.any(String));
      const stored = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(stored.tokenHash).not.toBe(result.refreshToken);
      expect(JSON.stringify(stored)).not.toContain(result.refreshToken);
      expect(stored).toMatchObject({
        userId: user.id,
        tenantId: tenant.id,
        userAgent: 'vitest',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: user.id },
        data: { lastLoginAt: expect.any(Date) },
      });
    });

    it('rejects a wrong password with the generic message', async () => {
      prisma.tenant.findUnique.mockResolvedValue(tenant);
      prisma.user.findUnique.mockResolvedValue(user);

      await expect(
        service.login({ ...dto, password: 'wrong-pass' }),
      ).rejects.toThrow(new UnauthorizedException(INVALID_LOGIN_MESSAGE));
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an inactive user even with the right password', async () => {
      prisma.tenant.findUnique.mockResolvedValue(tenant);
      prisma.user.findUnique.mockResolvedValue({ ...user, isActive: false });

      await expect(service.login(dto)).rejects.toThrow(
        new UnauthorizedException(INVALID_LOGIN_MESSAGE),
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an inactive tenant and an unknown company with the same message', async () => {
      prisma.tenant.findUnique.mockResolvedValueOnce({
        ...tenant,
        isActive: false,
      });
      prisma.user.findUnique.mockResolvedValue(user);
      await expect(service.login(dto)).rejects.toThrow(INVALID_LOGIN_MESSAGE);

      prisma.tenant.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.login({ ...dto, companyCode: 'NOPE' }),
      ).rejects.toThrow(INVALID_LOGIN_MESSAGE);
    });
  });

  describe('refresh', () => {
    async function loginAndGetStoredToken() {
      prisma.tenant.findUnique.mockResolvedValue(tenant);
      prisma.user.findUnique.mockResolvedValue(user);
      const { refreshToken } = await service.login({
        companyCode: 'DEMO',
        phone: user.phone,
        password: 'admin123',
      });
      const { tokenHash, expiresAt } =
        prisma.refreshToken.create.mock.calls[0][0].data;
      prisma.refreshToken.create.mockClear();
      return {
        refreshToken,
        row: {
          id: 'rt-1',
          userId: user.id,
          tokenHash,
          expiresAt,
          revokedAt: null as Date | null,
          user: { ...user, tenant },
        },
      };
    }

    it('rotates: revokes the old token and issues a new pair', async () => {
      const { refreshToken, row } = await loginAndGetStoredToken();
      prisma.refreshToken.findUnique.mockResolvedValue(row);
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.refresh(refreshToken);

      // Looked up by hash, never by the raw token.
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: row.tokenHash } }),
      );
      // Old token revoked (only if it wasn't already)...
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // ...and a brand-new one stored.
      expect(result.refreshToken).not.toBe(refreshToken);
      const newRow = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(newRow.tokenHash).not.toBe(row.tokenHash);
      expect(await jwt.verifyAsync(result.accessToken)).toMatchObject({
        sub: user.id,
      });
    });

    it('treats reuse of a rotated token as theft and revokes all sessions', async () => {
      const { refreshToken, row } = await loginAndGetStoredToken();
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...row,
        revokedAt: new Date(),
      });

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects expired and unknown tokens', async () => {
      const { refreshToken, row } = await loginAndGetStoredToken();
      prisma.refreshToken.findUnique.mockResolvedValueOnce({
        ...row,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.refresh(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );

      prisma.refreshToken.findUnique.mockResolvedValueOnce(null);
      await expect(service.refresh('made-up-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects a refresh once the user has been deactivated', async () => {
      const { refreshToken, row } = await loginAndGetStoredToken();
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...row,
        user: { ...row.user, isActive: false },
      });

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });
});
