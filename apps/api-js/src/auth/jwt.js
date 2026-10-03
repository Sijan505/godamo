import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';

/** Cookie names for the web app's session (httpOnly; never readable by page scripts). */
export const ACCESS_COOKIE = 'godamo_at';
export const REFRESH_COOKIE = 'godamo_rt';

/** @param {{ sub: string, tenantId: string, role: string }} payload */
export function signAccessToken(payload) {
  return jwt.sign(payload, config.jwtAccessSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtAccessExpires,
  });
}

const unauthorized = () => new HttpError(401);

/** Reads one cookie from the Cookie header (no cookie library needed). */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Express middleware: needs a valid access token, sent as
 * "Authorization: Bearer <token>" (Field app, scripts) or, for the web app,
 * in the httpOnly session cookie. Sets req.user = { userId, tenantId, role };
 * that tenantId is the ONLY trusted tenant id.
 */
export function authenticate(req, _res, next) {
  const header = req.headers.authorization;
  let token;
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    token = match?.[1];
  } else {
    token = readCookie(req, ACCESS_COOKIE);
    if (token) {
      req.viaCookie = true;
      // CSRF defence in depth (the cookie is also SameSite=Lax): a cookie
      // session may only change data from pages served by this server.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && safeHost(origin) !== req.headers.host) {
          return next(new HttpError(403, { message: 'Cross-site request blocked', statusCode: 403 }));
        }
      }
    }
  }
  if (!token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'] });
    req.user = { userId: payload.sub, tenantId: payload.tenantId, role: payload.role };
    next();
  } catch {
    next(unauthorized());
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
