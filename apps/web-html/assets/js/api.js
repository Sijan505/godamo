/**
 * Browser-side API helper. Calls go to /api/v1 on this same server; the
 * session lives in httpOnly cookies, so no token is ever handled here. On a
 * 401 the session is refreshed once; if that fails we go to the login page.
 */

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}`;
  // Full page load on purpose: start clean without the old session.
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

async function errorFrom(res) {
  const body = await res.json().catch(() => null);
  const raw = body?.message;
  const message = Array.isArray(raw) ? raw.join(', ') : (raw ?? `Request failed (${res.status})`);
  return new ApiError(res.status, message, body);
}

// One refresh at a time, shared by every request that hit a 401 together.
let refreshing = null;
function refreshSession() {
  refreshing ??= fetch('/web-auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

async function send(url, init) {
  try {
    return await fetch(url, {
      ...init,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(503, 'Cannot reach the Godamo server. Please try again shortly.');
  }
}

/** Call the Godamo API, e.g. apiFetch('/dashboard/summary'). JSON in, JSON out. */
export async function apiFetch(path, init = {}) {
  const url = `/api/v1${path.startsWith('/') ? path : `/${path}`}`;
  let res = await send(url, init);
  if (res.status === 401 && (await refreshSession())) res = await send(url, init);
  if (res.status === 401) {
    redirectToLogin();
    throw await errorFrom(res);
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

/** The logged-in user: { id, name, phone, email, role, tenantName, tenantCode, … }. */
export function getMe() {
  return apiFetch('/auth/me');
}

export async function logout() {
  await fetch('/web-auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
  // Full page load on purpose: start clean without the old session.
  window.location.assign('/login');
}
