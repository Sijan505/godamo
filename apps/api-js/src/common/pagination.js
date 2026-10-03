import { isInt, max, min, optional, schema, toNumber } from '../http/validation.js';

/** page (default 1) and limit (default 20, max 100) query fields; spread into other query schemas. */
export const paginationFields = {
  page: [optional(), toNumber(), isInt(), min(1)],
  limit: [optional(), toNumber(), isInt(), min(1), max(100)],
};
export const paginationDefaults = { page: 1, limit: 20 };

export const PaginationQueryDto = schema(paginationFields, { defaults: paginationDefaults });

export function pageArgs({ page, limit }) {
  return { skip: (page - 1) * limit, take: limit };
}
