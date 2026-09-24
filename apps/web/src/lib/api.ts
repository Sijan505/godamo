/**
 * Browser-side API helper. Every call goes through the same-origin BFF proxy
 * (/api/proxy/...), which adds the token from the httpOnly cookie. On 401 the
 * session is over, so we go to the login page.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function redirectToLogin() {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${window.location.search}`;
  // Full page load on purpose: start clean without the old session/cache.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

async function errorFrom(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
  const raw = body?.message;
  const message = Array.isArray(raw) ? raw.join(", ") : (raw ?? `Request failed (${res.status})`);
  return new ApiError(res.status, message, body);
}

/** fetch() against a same-origin route; JSON in, JSON out. */
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) {
    redirectToLogin();
    throw await errorFrom(res);
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Call the Godamo API, e.g. apiFetch("/dashboard/summary"). */
export function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(`/api/proxy${path.startsWith("/") ? path : `/${path}`}`, init);
}
