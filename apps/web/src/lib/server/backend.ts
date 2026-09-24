import { cookies, headers } from "next/headers";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth-cookies";

/**
 * Server-only helpers for the BFF: talk to the Godamo API with the tokens kept
 * in httpOnly cookies. Import only from Route Handlers.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // matches JWT_REFRESH_EXPIRES_DAYS=30

export function apiUrl(path: string): string {
  const base = process.env.API_URL;
  if (!base) throw new Error("API_URL is not set (see apps/web/.env.example)");
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/** Seconds until the JWT's `exp` (the access cookie expires with the token). */
function secondsUntilExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
    ) as { exp?: number };
    if (payload.exp) return Math.max(payload.exp - Math.floor(Date.now() / 1000), 0);
  } catch {
    // fall through
  }
  return 15 * 60;
}

export async function setSessionCookies(tokens: TokenPair) {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(secondsUntilExpiry(tokens.accessToken)));
  jar.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(REFRESH_TTL_SECONDS));
}

export async function clearSessionCookies() {
  const jar = await cookies();
  jar.delete({ name: ACCESS_COOKIE, path: "/" });
  jar.delete({ name: REFRESH_COOKIE, path: "/" });
}

/** Headers identifying the real client to the API (rate limits, audit). */
export async function clientHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const out: Record<string, string> = {};
  // Only the last hop (added by the proxy closest to us) is trustworthy; the
  // left-most entries can be typed in by anyone. In production put Next.js
  // behind a reverse proxy that sets X-Forwarded-For / X-Real-IP.
  const lastHop = h.get("x-forwarded-for")?.split(",").pop()?.trim();
  const clientIp = lastHop || h.get("x-real-ip");
  if (clientIp) out["x-forwarded-for"] = clientIp;
  const ua = h.get("user-agent");
  if (ua) out["user-agent"] = ua;
  return out;
}

// ─── Refresh (de-duplicated) ────────────────────────────────────────────────
//
// The API rotates refresh tokens and treats reuse of an old one as theft
// (it revokes every session). When the access token expires, several requests
// (dashboard queries, the "me" call…) may try to refresh at once with the same
// token, so: share one in-flight refresh per token, and remember old -> new for
// a short time so a request that still carried the old cookie gets the new pair.
// This is per server process; run a single web instance or use sticky sessions.

const inflight = new Map<string, Promise<TokenPair | null>>();
const recentlyRotated = new Map<string, { tokens: TokenPair; at: number }>();
const ROTATION_GRACE_MS = 30_000;

async function callRefresh(refreshToken: string): Promise<TokenPair | null> {
  const res = await fetch(apiUrl("/auth/refresh"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(await clientHeaders()) },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const tokens = (await res.json()) as TokenPair;
  const now = Date.now();
  recentlyRotated.set(refreshToken, { tokens, at: now });
  for (const [key, entry] of recentlyRotated) {
    if (now - entry.at > ROTATION_GRACE_MS) recentlyRotated.delete(key);
  }
  return tokens;
}

export function refreshTokens(refreshToken: string): Promise<TokenPair | null> {
  const recent = recentlyRotated.get(refreshToken);
  if (recent && Date.now() - recent.at < ROTATION_GRACE_MS) {
    return Promise.resolve(recent.tokens);
  }
  let pending = inflight.get(refreshToken);
  if (!pending) {
    pending = callRefresh(refreshToken).finally(() => inflight.delete(refreshToken));
    inflight.set(refreshToken, pending);
  }
  return pending;
}

// ─── Authenticated calls ────────────────────────────────────────────────────

function unauthorized() {
  return Response.json(
    { statusCode: 401, message: "Your session has ended. Please log in again." },
    { status: 401 },
  );
}

/**
 * Calls the API with the access token from the cookie. Refreshes once when the
 * token is missing/expired (401), updating the cookies; if the refresh fails the
 * cookies are cleared and a 401 is returned.
 */
export async function backendFetch(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null } = {},
): Promise<Response> {
  const jar = await cookies();
  let access = jar.get(ACCESS_COOKIE)?.value;
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  const extra = await clientHeaders();

  const call = (token: string) =>
    fetch(apiUrl(path), {
      method: init.method ?? "GET",
      headers: { ...extra, ...init.headers, authorization: `Bearer ${token}` },
      body: init.body,
      cache: "no-store",
      redirect: "manual",
    });

  const renew = async () => {
    const tokens = refresh ? await refreshTokens(refresh) : null;
    if (!tokens) {
      await clearSessionCookies();
      return null;
    }
    await setSessionCookies(tokens);
    return tokens.accessToken;
  };

  if (!access) {
    access = (await renew()) ?? undefined;
    if (!access) return unauthorized();
    return call(access);
  }

  const res = await call(access);
  if (res.status !== 401) return res;
  const renewed = await renew();
  if (!renewed) return unauthorized();
  return call(renewed);
}
