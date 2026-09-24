import { Transform } from 'class-transformer';

/** Nepali mobile number: 10 digits starting with 97 or 98. */
export const NEPALI_MOBILE_REGEX = /^9[78]\d{8}$/;
export const NEPALI_MOBILE_MESSAGE =
  'phone must be a 10-digit Nepali mobile number starting with 97 or 98';

/** bcrypt only uses the first 72 bytes of a password. */
export const PASSWORD_MAX_LENGTH = 72;

export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
