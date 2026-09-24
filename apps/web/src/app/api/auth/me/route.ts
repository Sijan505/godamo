import { backendFetch } from "@/lib/server/backend";

/** GET /api/auth/me: the logged-in user's profile (refreshes the session if needed). */
export async function GET() {
  const res = await backendFetch("/auth/me");
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
