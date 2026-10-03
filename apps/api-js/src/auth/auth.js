import bcrypt from 'bcrypt';
import { createHmac, randomBytes } from 'node:crypto';
import { auditLog } from '../common/audit.js';
import { NEPALI_MOBILE_MESSAGE, NEPALI_MOBILE_REGEX, PASSWORD_MAX_LENGTH } from '../common/roles.js';
import { config } from '../config.js';
import { AuditAction, prisma } from '../db.js';
import { BadRequest, NotFound, Unauthorized } from '../http/errors.js';
import { controller, rateLimit } from '../http/router.js';
import {
  isNotEmpty,
  isString,
  length,
  matches,
  maxLength,
  schema,
  trim,
  upperTrim,
} from '../http/validation.js';
import { signAccessToken } from './jwt.js';

export const INVALID_LOGIN_MESSAGE = 'Invalid company code, phone or password';
const INVALID_REFRESH_MESSAGE = 'Invalid or expired refresh token';
export const BCRYPT_ROUNDS = 10;

const refreshTtlMs = config.jwtRefreshExpiresDays * 24 * 60 * 60 * 1000;
// Compared against when the company or phone doesn't exist, so every failed
// login costs one bcrypt compare and response time doesn't reveal which part was wrong.
const dummyHash = bcrypt.hashSync('godamo-timing-guard', BCRYPT_ROUNDS);

// ─── Request bodies ─────────────────────────────────────────────────────────

export const LoginDto = schema({
  companyCode: [upperTrim(), isString(), length(2, 20)],
  phone: [trim(), matches(NEPALI_MOBILE_REGEX, NEPALI_MOBILE_MESSAGE)],
  password: [isString(), isNotEmpty(), maxLength(PASSWORD_MAX_LENGTH)],
});

export const RefreshTokenDto = schema({
  refreshToken: [isString(), isNotEmpty(), maxLength(200)],
});

const ChangePasswordDto = schema({
  currentPassword: [isString(), isNotEmpty(), maxLength(PASSWORD_MAX_LENGTH)],
  newPassword: [isString(), length(8, PASSWORD_MAX_LENGTH)],
});

// ─── Service ────────────────────────────────────────────────────────────────

export async function login(dto, userAgent) {
  const tenant = await prisma.tenant.findUnique({ where: { code: dto.companyCode } });
  const user = tenant
    ? await prisma.user.findUnique({
        where: { tenantId_phone: { tenantId: tenant.id, phone: dto.phone } },
      })
    : null;
  const passwordOk = await bcrypt.compare(dto.password, user?.passwordHash ?? dummyHash);

  if (!tenant?.isActive || !user?.isActive || !passwordOk) {
    throw Unauthorized(INVALID_LOGIN_MESSAGE);
  }

  const tokens = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return issueTokens(user, tx, userAgent);
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
export async function refresh(rawToken, userAgent) {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: { include: { tenant: true } } },
  });
  if (!stored || stored.expiresAt <= new Date()) {
    throw Unauthorized(INVALID_REFRESH_MESSAGE);
  }
  if (stored.revokedAt) {
    // An already-rotated token is being replayed, so it has probably leaked.
    // End every session for this user; they must log in again.
    await revokeAllForUser(stored.userId);
    throw Unauthorized(INVALID_REFRESH_MESSAGE);
  }
  const { user } = stored;
  if (!user.isActive || !user.tenant.isActive) {
    throw Unauthorized(INVALID_REFRESH_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    // Conditional update so two concurrent refreshes with the same token can't both win.
    const { count } = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw Unauthorized(INVALID_REFRESH_MESSAGE);
    return issueTokens(user, tx, userAgent);
  });
}

/** Revokes one refresh token, if it belongs to the caller. Always succeeds silently. */
export async function logout(current, rawToken) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), userId: current.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes a refresh token without knowing its owner (web logout with an expired access token). */
export async function revokeRefreshToken(rawToken) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function me(current) {
  const user = await prisma.user.findFirst({
    where: { id: current.userId, tenantId: current.tenantId },
    include: { tenant: true },
  });
  if (!user) throw NotFound('User not found');
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
export async function changePassword(current, dto) {
  const user = await prisma.user.findFirst({
    where: { id: current.userId, tenantId: current.tenantId },
  });
  if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
    throw BadRequest('Current password is incorrect');
  }
  const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await revokeAllForUser(user.id, tx);
    await auditLog(
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

export async function revokeAllForUser(userId, db = prisma) {
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function issueTokens(user, db, userAgent) {
  const accessToken = signAccessToken({ sub: user.id, tenantId: user.tenantId, role: user.role });

  const refreshToken = randomBytes(48).toString('base64url');
  await db.refreshToken.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + refreshTtlMs),
      userAgent: userAgent?.slice(0, 255),
    },
  });

  return { accessToken, refreshToken };
}

// Refresh tokens are 384 random bits, so a keyed SHA-256 is enough (and, unlike
// bcrypt, lets us look the token up by its hash). The raw token is never stored.
function hashToken(rawToken) {
  return createHmac('sha256', config.jwtRefreshSecret).update(rawToken).digest('hex');
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** At most 5 login attempts a minute per IP (shared by the API and web logins). */
export const loginLimiter = rateLimit({ limit: 5, ttlMs: 60_000 });

const r = controller('/auth');

r.post(
  '/login',
  { public: true, status: 200, middleware: [loginLimiter], body: LoginDto },
  ({ body, req }) => login(body, req.headers['user-agent']),
);

r.post('/refresh', { public: true, status: 200, body: RefreshTokenDto }, ({ body, req }) =>
  refresh(body.refreshToken, req.headers['user-agent']),
);

r.post('/logout', { status: 204, body: RefreshTokenDto }, ({ user, body }) =>
  logout(user, body.refreshToken),
);

r.get('/me', ({ user }) => me(user));

r.post('/change-password', { status: 204, body: ChangePasswordDto }, ({ user, body }) =>
  changePassword(user, body),
);

export const authRoutes = r;
