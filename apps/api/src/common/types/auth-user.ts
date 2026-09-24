import type { UserRole } from '../../generated/prisma/client.js';

/** Payload signed into every access token. */
export interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  role: UserRole;
}

/** What @CurrentUser() returns. tenantId here is the ONLY trusted tenant id. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: UserRole;
}
