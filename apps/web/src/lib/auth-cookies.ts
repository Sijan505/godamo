/**
 * Cookie names for the BFF session. Both cookies are httpOnly: the tokens are
 * only ever read by Next.js server code, never by browser JavaScript.
 */
export const ACCESS_COOKIE = "godamo_at";
export const REFRESH_COOKIE = "godamo_rt";

/** Where each role lands after login. */
export function landingPath(role: string): string {
  return role === "GODOWN" ? "/stock" : "/dashboard";
}

/** Only allow same-site relative paths as a post-login redirect (no open redirects). */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return null;
  }
  if (next.startsWith("/login") || next.startsWith("/api")) return null;
  return next;
}
