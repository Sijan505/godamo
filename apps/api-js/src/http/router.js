/**
 * A thin layer over Express so each feature declares its routes in one place:
 *
 *   const r = controller('/users', { roles: [UserRole.OWNER, UserRole.MANAGER] });
 *   r.patch('/:id', { params: { id: 'uuid' }, body: UpdateUserDto }, ({ user, params, body }) =>
 *     users.update(user, params.id, body));
 *
 * Every route needs a logged-in user unless `public: true`. `roles` limits it
 * further. Params, query and body are validated (in that order) before the
 * handler runs. The handler's return value is sent as JSON; POST answers 201
 * and everything else 200 unless `status` says otherwise.
 */
import express from 'express';
import { authenticate } from '../auth/jwt.js';
import { BadRequest, Forbidden, HttpError } from './errors.js';
import { isUuidString, validate, validateArray } from './validation.js';

const asyncRoute = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function controller(prefix, defaults = {}) {
  const router = express.Router({ mergeParams: true });
  const add = (method) => (path, options, handler) => {
    if (typeof options === 'function') {
      handler = options;
      options = {};
    }
    const opts = { ...defaults, ...options };
    const chain = [];
    if (!opts.public) chain.push(authenticate);
    if (opts.roles?.length) {
      chain.push((req, _res, next) => {
        if (!req.user || !opts.roles.includes(req.user.role)) {
          return next(Forbidden({ message: 'Forbidden resource', error: 'Forbidden', statusCode: 403 }));
        }
        next();
      });
    }
    for (const mw of opts.middleware ?? []) chain.push(mw);
    chain.push(
      asyncRoute(async (req, res) => {
        const params = { ...req.params };
        for (const [name, kind] of Object.entries(opts.params ?? {})) {
          if (kind === 'uuid' && !isUuidString(params[name])) {
            throw BadRequest('Validation failed (uuid is expected)');
          }
        }
        const query = opts.query ? validate(opts.query, plainQuery(req.query)) : req.query;
        const body = opts.bodyArray
          ? validateArray(opts.bodyArray, req.body)
          : opts.body
            ? validate(opts.body, req.body)
            : req.body;

        const result = await handler({ user: req.user, params, query, body, req, res });
        if (res.headersSent) return;
        res.status(opts.status ?? (method === 'post' ? 201 : 200));
        if (result === undefined || result === null) return res.end();
        if (Buffer.isBuffer(result)) return res.send(result);
        return res.json(result);
      }),
    );
    router[method](path, ...chain);
  };
  return {
    prefix,
    router,
    get: add('get'),
    post: add('post'),
    put: add('put'),
    patch: add('patch'),
    delete: add('delete'),
  };
}

// Express gives query values as strings, arrays or nested objects; keep a plain copy.
function plainQuery(query) {
  return { ...query };
}

/** Express error handler: HttpErrors keep their body, everything else is a 500. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json(err.body);
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: err.message, error: 'Bad Request', statusCode: 400 });
  }
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ message: 'request entity too large', error: 'Payload Too Large', statusCode: 413 });
  }
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    return res
      .status(err.status)
      .json({ message: err.message, statusCode: err.status });
  }
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ statusCode: 500, message: 'Internal server error' });
}

/** Unknown routes: 404 like "Cannot GET /api/v1/nope". */
export function notFoundHandler(req, res) {
  res.status(404).json({
    message: `Cannot ${req.method} ${req.originalUrl.split('?')[0]}`,
    error: 'Not Found',
    statusCode: 404,
  });
}

/**
 * Simple fixed-window rate limit per client IP (in memory, per process):
 * at most `limit` requests per `ttlMs` on the routes it is added to.
 */
export function rateLimit({ limit, ttlMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + ttlMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) {
      for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
    }
    if (entry.count > limit) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' });
    }
    next();
  };
}
