/**
 * A small `expect` for node:test, with the matchers our tests use:
 *   expect(x).toBe(y), .toEqual(y), .toMatchObject(y), .toThrow(msg),
 *   expect(x).not.toBe(y), await expect(promise).rejects.toThrow(msg) …
 */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

/** Like toEqual in Jest/Vitest: object properties set to undefined are ignored. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, clean(v)]),
    );
  }
  return value;
}

function matchesObject(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
  }
  if (expected && typeof expected === 'object' && Object.getPrototypeOf(expected) === Object.prototype) {
    return !!actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => matchesObject(actual[k], v));
  }
  return isDeepStrictEqual(actual, expected);
}

function throwMatches(error, expected) {
  if (expected === undefined) return true;
  if (typeof expected === 'string') return String(error?.message).includes(expected);
  if (expected instanceof RegExp) return expected.test(String(error?.message));
  if (typeof expected === 'function') return error instanceof expected;
  return false;
}

function matchers(actual, negate) {
  const check = (ok, message) => {
    if (negate ? ok : !ok) assert.fail(negate ? `Expected not: ${message}` : message);
  };
  const show = (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  return {
    toBe: (e) => check(Object.is(actual, e), `${show(actual)} to be ${show(e)}`),
    toEqual: (e) => check(isDeepStrictEqual(clean(actual), clean(e)), `${show(actual)} to equal ${show(e)}`),
    toMatchObject: (e) => check(matchesObject(actual, e), `${show(actual)} to match ${show(e)}`),
    toBeNull: () => check(actual === null, `${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `${show(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, 'value to be defined'),
    toBeLessThan: (e) => check(actual < e, `${show(actual)} to be less than ${show(e)}`),
    toContain: (e) =>
      check(
        typeof actual === 'string' ? actual.includes(e) : [...actual].some((x) => isDeepStrictEqual(x, e)),
        `${show(actual)} to contain ${show(e)}`,
      ),
    toHaveLength: (n) => check(actual?.length === n, `length ${actual?.length} to be ${n}`),
    toMatch: (re) => check((typeof re === 'string' ? new RegExp(re) : re).test(actual), `${show(actual)} to match ${re}`),
    toThrow: (e) => {
      let error;
      let threw = false;
      try {
        actual();
      } catch (err) {
        threw = true;
        error = err;
      }
      check(threw && throwMatches(error, e), `function to throw ${e ?? ''} (got ${error?.message ?? 'no error'})`);
    },
  };
}

export function expect(actual) {
  return {
    ...matchers(actual, false),
    not: matchers(actual, true),
    rejects: {
      async toThrow(e) {
        let error;
        let threw = false;
        try {
          await actual;
        } catch (err) {
          threw = true;
          error = err;
        }
        if (!threw || !throwMatches(error, e)) {
          assert.fail(`promise to reject with ${e ?? 'an error'} (got ${error?.message ?? 'a value'})`);
        }
      },
    },
  };
}
