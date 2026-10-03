/**
 * Request validation.
 *
 * A schema maps each allowed field to a list of rules, written in the order
 * you would read them. Unknown fields are rejected, transforms (trim, number
 * conversion…) run first, and every failed rule adds a message such as
 * "name must be a string". The messages and their order are the same as the
 * API has always produced, so clients that show them keep working.
 *
 *   const LoginDto = schema({
 *     companyCode: [upperTrim(), isString(), length(2, 20)],
 *     phone: [trim(), matches(NEPALI_MOBILE_REGEX, NEPALI_MOBILE_MESSAGE)],
 *   });
 *   const dto = validate(LoginDto, req.body); // throws a 400 on bad input
 */
import { BadRequest } from './errors.js';

// ─── Schema ─────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, object[]>} fields field name -> rules
 * @param {{ defaults?: Record<string, unknown> }} [options] values used when a field is missing
 */
export function schema(fields, { defaults = {} } = {}) {
  return { fields, defaults };
}

// ─── Rule builders ──────────────────────────────────────────────────────────

const rule = (name, test, message) => ({ kind: 'rule', name, test, message });
const transform = (fn) => ({ kind: 'transform', fn });

/** Skip every rule when the value is null or undefined. */
export const optional = () => ({ kind: 'optional' });
/** Skip every rule unless `cond(value, object)` is true. */
export const validateIf = (cond) => ({ kind: 'if', cond });

export const trim = () => transform((v) => (typeof v === 'string' ? v.trim() : v));
export const upperTrim = () =>
  transform((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v));
/** Query-string boolean: "true"/"false" -> true/false. */
export const queryBoolean = () =>
  transform((v) => (v === 'true' ? true : v === 'false' ? false : v));
/** Query-string number (like Number(value); arrays convert each item). */
export const toNumber = () =>
  transform((v) =>
    v === null || v === undefined ? v : Array.isArray(v) ? v.map(Number) : Number(v),
  );
export const custom = (fn) => transform(fn);

const UUID_REGEX =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export const isUuidString = (v) => typeof v === 'string' && UUID_REGEX.test(v);

export const isString = () =>
  rule('isString', (v) => typeof v === 'string', (p) => `${p} must be a string`);

export const isNotEmpty = () =>
  rule(
    'isNotEmpty',
    (v) => v !== '' && v !== null && v !== undefined,
    (p) => `${p} should not be empty`,
  );

export const length = (min, max) =>
  rule(
    'isLength',
    (v) => typeof v === 'string' && v.length >= min && (max === undefined || v.length <= max),
    (p, v) => {
      if (!v || v.length < min) return `${p} must be longer than or equal to ${min} characters`;
      if (max !== undefined && v.length > max) {
        return `${p} must be shorter than or equal to ${max} characters`;
      }
      return `${p} must be longer than or equal to ${min} and shorter than or equal to ${max} characters`;
    },
  );

export const maxLength = (max) =>
  rule(
    'maxLength',
    (v) => typeof v === 'string' && v.length <= max,
    (p) => `${p} must be shorter than or equal to ${max} characters`,
  );

export const matches = (regex, message) =>
  rule(
    'matches',
    (v) => typeof v === 'string' && regex.test(v),
    (p) => message ?? `${p} must match ${regex} regular expression`,
  );

export const isUuid = () => rule('isUuid', isUuidString, (p) => `${p} must be a UUID`);

/** Every item of an array is a UUID (a non-array value is checked as one item). */
export const isUuidEach = () =>
  rule(
    'isUuid',
    (v) => (Array.isArray(v) ? v.every(isUuidString) : isUuidString(v)),
    (p) => `each value in ${p} must be a UUID`,
  );

/** @param {{ maxDecimalPlaces?: number }} [options] */
export const isNumber = (options = {}) =>
  rule(
    'isNumber',
    (v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (options.maxDecimalPlaces !== undefined && v % 1 !== 0) {
        return v.toString().split('.')[1].length <= options.maxDecimalPlaces;
      }
      return true;
    },
    (p) => `${p} must be a number conforming to the specified constraints`,
  );

export const isInt = () =>
  rule('isInt', (v) => typeof v === 'number' && Number.isInteger(v), (p) => `${p} must be an integer number`);

export const isPositive = () =>
  rule('isPositive', (v) => typeof v === 'number' && v > 0, (p) => `${p} must be a positive number`);

export const min = (n) =>
  rule('min', (v) => typeof v === 'number' && v >= n, (p) => `${p} must not be less than ${n}`);

export const max = (n) =>
  rule('max', (v) => typeof v === 'number' && v <= n, (p) => `${p} must not be greater than ${n}`);

export const isBoolean = () =>
  rule('isBoolean', (v) => typeof v === 'boolean', (p) => `${p} must be a boolean value`);

/** @param {Record<string, string>} enumObject e.g. UserRole */
export const isEnum = (enumObject) => {
  const values = Object.entries(enumObject)
    .filter(([key]) => Number.isNaN(parseInt(key, 10)))
    .map(([, value]) => value);
  return rule(
    'isEnum',
    (v) => values.includes(v),
    (p) => `${p} must be one of the following values: ${values.join(', ')}`,
  );
};

export const isIn = (values) =>
  rule('isIn', (v) => values.includes(v), (p) => `${p} must be one of the following values: ${values.join(', ')}`);

export const notEquals = (value) =>
  rule('notEquals', (v) => v !== value, (p) => `${p} should not be equal to ${value}`);

export const isArray = () =>
  rule('isArray', (v) => Array.isArray(v), (p) => `${p} must be an array`);

export const arrayMinSize = (n) =>
  rule(
    'arrayMinSize',
    (v) => Array.isArray(v) && v.length >= n,
    (p) => `${p} must contain at least ${n} elements`,
  );

export const arrayMaxSize = (n) =>
  rule(
    'arrayMaxSize',
    (v) => Array.isArray(v) && v.length <= n,
    (p) => `${p} must contain no more than ${n} elements`,
  );

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A "YYYY-MM-DD" date that exists on the calendar. (Listed in reverse so the
 * format message is reported before the calendar one.)
 */
export const dateOnly = () => [
  rule('isDateString', isStrictIsoDate, (p) => `${p} must be a valid ISO 8601 date string`),
  rule('matches', (v) => typeof v === 'string' && DATE_ONLY_REGEX.test(v), (p) => `${p} must be YYYY-MM-DD`),
];

// validator.js isISO8601 with { strict: true }: the format must parse and the day must exist.
const ISO8601 =
  /^([+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([.,]\d+(?!:))?)?(\17[0-5]\d([.,]\d+)?)?([zZ]|([+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$/;
function isStrictIsoDate(v) {
  if (typeof v !== 'string' || !ISO8601.test(v)) return false;
  const ordinal = v.match(/^(\d{4})-?(\d{3})([ T]{1}\.*|$)/);
  if (ordinal) {
    const year = Number(ordinal[1]);
    const day = Number(ordinal[2]);
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap || day <= 365;
  }
  const match = v.match(/(\d{4})-?(\d{0,2})-?(\d*)/).map(Number);
  const [, year, month, day] = match;
  const monthString = month ? `0${month}`.slice(-2) : month;
  const dayString = day ? `0${day}`.slice(-2) : day;
  const d = new Date(`${year}-${monthString || '01'}-${dayString || '01'}`);
  if (month && day) {
    return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
  }
  return true;
}

/**
 * Nested object(s) validated against `child`. With `each`, the value is an
 * array and every item is validated.
 */
export const nested = (child) => ({ kind: 'nested', child });

/** A rule written inline: `check(value) -> boolean`. */
export const check = (name, test, message) => rule(name, test, message);

// ─── Running a schema ───────────────────────────────────────────────────────

/**
 * Validates and transforms `input`; returns the cleaned object or throws a 400
 * whose message is the list of problems.
 */
export function validate(def, input) {
  const { value, errors } = run(def, input);
  if (errors.length) throw BadRequest(errors);
  return value;
}

/**
 * A body that is a JSON array of items (e.g. PUT /products/:id/prices). The
 * first bad item's problems are reported.
 */
export function validateArray(def, input) {
  if (!Array.isArray(input)) throw BadRequest('Validation failed (parsable array expected)');
  return input.map((item) => validate(def, item));
}

function run(def, input) {
  // A missing body counts as {}; an array counts as an object keyed "0", "1"…
  if (input === null || input === undefined) input = {};
  if (typeof input !== 'object') {
    return { value: input, errors: ['an unknown value was passed to the validate function'] };
  }

  const out = { ...def.defaults };
  for (const [key, val] of Object.entries(input)) out[key] = val;

  const errors = [];
  // Unknown fields first.
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(def.fields, key)) errors.push(`property ${key} should not exist`);
  }

  for (const [key, rawRules] of Object.entries(def.fields)) {
    const rules = rawRules.flat();
    let value = out[key];
    for (const r of rules) if (r.kind === 'transform' && key in out) value = r.fn(value);
    // Nested objects are rebuilt from their own schema.
    const nestedRule = rules.find((r) => r.kind === 'nested');

    if (key in out) out[key] = value;

    const isOptional = rules.some((r) => r.kind === 'optional');
    if (isOptional && (value === null || value === undefined)) continue;
    const condition = rules.find((r) => r.kind === 'if');
    if (condition && !condition.cond(out, value)) continue;

    // Messages come out last rule first (as the API always reported them).
    const own = [];
    for (const r of [...rules].reverse()) {
      if (r.kind === 'rule' && !r.test(value)) own.push(r.message(key, value));
    }

    if (nestedRule && value !== undefined) {
      const notObject = `each value in nested property ${key} must be either object or array`;
      const childErrors = [];
      if (Array.isArray(value)) {
        const cleaned = value.map((item, i) => {
          if (item !== null && typeof item === 'object') {
            const res = run(nestedRule.child, item);
            childErrors.push(...res.errors.map((m) => `${key}.${i}.${m}`));
            return res.value;
          }
          childErrors.push(`${key}.${notObject}`);
          return item;
        });
        out[key] = cleaned;
      } else if (value !== null && typeof value === 'object') {
        const res = run(nestedRule.child, value);
        childErrors.push(...res.errors.map((m) => `${key}.${m}`));
        out[key] = res.value;
      } else {
        own.push(notObject);
      }
      // When the children have problems only theirs are reported.
      if (childErrors.length) {
        errors.push(...childErrors);
        continue;
      }
    }
    errors.push(...own);
  }
  return { value: out, errors };
}
