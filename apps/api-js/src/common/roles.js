import { UserRole } from '../db.js';

/** Roles that may create or change master data (products, prices, parties…). Everyone else is read-only. */
export const MASTER_DATA_WRITE_ROLES = [UserRole.OWNER, UserRole.MANAGER, UserRole.OFFICE];

/** Nepali mobile number: 10 digits starting with 97 or 98. */
export const NEPALI_MOBILE_REGEX = /^9[78]\d{8}$/;
export const NEPALI_MOBILE_MESSAGE =
  'phone must be a 10-digit Nepali mobile number starting with 97 or 98';

/** bcrypt only uses the first 72 bytes of a password. */
export const PASSWORD_MAX_LENGTH = 72;
