/**
 * Session endpoints for the browser app (served by this same server).
 *
 * The Field app and scripts use /api/v1/auth/* and keep tokens themselves.
 * The web app instead keeps both tokens in httpOnly cookies, so page scripts
 * never see a token: it logs in through /web-auth/login, then calls
 * /api/v1/* normally (the access cookie authenticates it), and on a 401 asks
 * /web-auth/refresh for a new pair once before sending the user to /login.
 */
import express from 'express';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';
import { validate } from '../http/validation.js';
import { LoginDto, login, loginLimiter, refresh, revokeRefreshToken } from './auth.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, readCookie } from './jwt.js';

const REFRESH_TTL_SECONDS = config.jwtRefreshExpiresDays * 24 * 60 * 60;

function cookie(name, value, maxAge) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (config.production) parts.push('Secure');
  return parts.join('; ');
}

/** Seconds until the JWT's `exp` (the access cookie expires with the token). */
function secondsUntilExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    if (payload.exp) return Math.max(payload.exp - Math.floor(Date.now() / 1000), 0);
  } catch {
    // fall through
  }
  return 15 * 60;
}

function setSessionCookies(res, tokens) {
  res.setHeader('Set-Cookie', [
    cookie(ACCESS_COOKIE, tokens.accessToken, secondsUntilExpiry(tokens.accessToken)),
    cookie(REFRESH_COOKIE, tokens.refreshToken, REFRESH_TTL_SECONDS),
  ]);
}

function clearSessionCookies(res) {
  res.setHeader('Set-Cookie', [cookie(ACCESS_COOKIE, '', 0), cookie(REFRESH_COOKIE, '', 0)]);
}

/** Only allow requests from our own pages to change the session (CSRF defence). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ─── Refresh (de-duplicated) ────────────────────────────────────────────────
//
// Refresh tokens rotate and reusing an old one counts as theft (every session
// is revoked). Several requests from one page (or two tabs) can hit a 401 at
// the same moment, so: share one in-flight refresh per token, and remember
// old -> new for a short time so a late request still gets the new pair.

const inflight = new Map();
const recentlyRotated = new Map();
const ROTATION_GRACE_MS = 30_000;

function refreshOnce(refreshToken, userAgent) {
  const recent = recentlyRotated.get(refreshToken);
  if (recent && Date.now() - recent.at < ROTATION_GRACE_MS) return Promise.resolve(recent.tokens);
  let pending = inflight.get(refreshToken);
  if (!pending) {
    pending = refresh(refreshToken, userAgent)
      .then((tokens) => {
        const now = Date.now();
        recentlyRotated.set(refreshToken, { tokens, at: now });
        for (const [key, entry] of recentlyRotated) {
          if (now - entry.at > ROTATION_GRACE_MS) recentlyRotated.delete(key);
        }
        return tokens;
      })
      .catch(() => null)
      .finally(() => inflight.delete(refreshToken));
    inflight.set(refreshToken, pending);
  }
  return pending;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export function webSessionRouter() {
  const router = express.Router();
  const blocked = (res) =>
    res.status(403).json({ message: 'Cross-site request blocked', statusCode: 403 });

  /** Logs in and sets the cookies; only the user profile reaches the browser. */
  router.post('/login', loginLimiter, async (req, res) => {
    if (!sameOrigin(req)) return blocked(res);
    try {
      const dto = validate(LoginDto, req.body);
      const { accessToken, refreshToken, user } = await login(dto, req.headers['user-agent']);
      setSessionCookies(res, { accessToken, refreshToken });
      res.json({ user });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      const raw = e.body.message;
      res.status(e.status).json({ message: Array.isArray(raw) ? raw.join(', ') : raw });
    }
  });

  /** New token pair from the refresh cookie; 401 (and cookies cleared) when the session is over. */
  router.post('/refresh', async (req, res) => {
    if (!sameOrigin(req)) return blocked(res);
    const token = readCookie(req, REFRESH_COOKIE);
    const tokens = token ? await refreshOnce(token, req.headers['user-agent']) : null;
    if (!tokens) {
      clearSessionCookies(res);
      return res
        .status(401)
        .json({ statusCode: 401, message: 'Your session has ended. Please log in again.' });
    }
    setSessionCookies(res, tokens);
    res.status(204).end();
  });

  /** Revokes the refresh token (best effort) and clears the cookies. */
  router.post('/logout', async (req, res) => {
    if (!sameOrigin(req)) return blocked(res);
    const token = readCookie(req, REFRESH_COOKIE);
    if (token) await revokeRefreshToken(token).catch(() => undefined);
    clearSessionCookies(res);
    res.status(204).end();
  });

  return router;
}

/** True when the request carries a (possibly expired) web session. */
export function hasWebSession(req) {
  return !!(readCookie(req, ACCESS_COOKIE) || readCookie(req, REFRESH_COOKIE));
}
