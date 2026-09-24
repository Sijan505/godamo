import type { NextRequest } from "next/server";
import { backendFetch } from "@/lib/server/backend";

/**
 * /api/proxy/<path> -> API_URL/<path>, adding the access token from the
 * httpOnly cookie (and refreshing it once on 401). The browser never sees a token.
 */

const FORWARD_REQUEST_HEADERS = ["content-type", "accept"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-disposition", "cache-control"];

async function handle(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;

  // Keep requests inside the API: no "." / ".." segments.
  if (path.some((segment) => segment === "." || segment === ".." || segment === "")) {
    return Response.json({ message: "Invalid path" }, { status: 400 });
  }

  // CSRF defence in depth (cookies are also SameSite=Lax): state-changing
  // requests must come from our own origin.
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.nextUrl.host) {
      return Response.json({ message: "Cross-site request blocked" }, { status: 403 });
    }
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const body = ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer();

  const target = `/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  let res: Response;
  try {
    res = await backendFetch(target, { method: request.method, headers, body });
  } catch {
    return Response.json(
      { message: "Cannot reach the Godamo server. Please try again shortly." },
      { status: 503 },
    );
  }

  const outHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  const noBody = res.status === 204 || res.status === 304;
  return new Response(noBody ? null : res.body, { status: res.status, headers: outHeaders });
}

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
