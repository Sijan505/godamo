import { Transform } from 'class-transformer';
import { IsDateString, Matches } from 'class-validator';
import { DATE_ONLY_REGEX } from './dates.js';

/** Nepali mobile number: 10 digits starting with 97 or 98. */
export const NEPALI_MOBILE_REGEX = /^9[78]\d{8}$/;
export const NEPALI_MOBILE_MESSAGE =
  'phone must be a 10-digit Nepali mobile number starting with 97 or 98';

/** bcrypt only uses the first 72 bytes of a password. */
export const PASSWORD_MAX_LENGTH = 72;

export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Optional query-string boolean: "true"/"false" -> true/false. */
export const QueryBoolean = () =>
  Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );

/** A "YYYY-MM-DD" date field. */
export const DateOnly = () => (target: object, key: string) => {
  Matches(DATE_ONLY_REGEX, { message: `${key} must be YYYY-MM-DD` })(
    target,
    key,
  );
  IsDateString({ strict: true })(target, key);
};
