import { UserRole } from '../generated/prisma/client.js';

/** Roles that may create or change master data (products, prices, parties…). Everyone else is read-only. */
export const MASTER_DATA_WRITE_ROLES = [
  UserRole.OWNER,
  UserRole.MANAGER,
  UserRole.OFFICE,
] as const;
