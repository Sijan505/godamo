import { apiUrl, clientHeaders, setSessionCookies, type TokenPair } from "@/lib/server/backend";

interface LoginResponse extends TokenPair {
  user: { id: string; name: string; role: string; tenantId: string; tenantName: string };
}

/**
 * POST /api/auth/login: forwards the credentials to the API and keeps the
 * returned tokens in httpOnly cookies. Only the user profile reaches the browser.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Invalid request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(apiUrl("/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(await clientHeaders()) },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { message: "Cannot reach the Godamo server. Please try again shortly." },
      { status: 503 },
    );
  }

  const data = (await res.json().catch(() => ({}))) as Partial<LoginResponse> & {
    message?: string | string[];
  };
  if (!res.ok || !data.accessToken || !data.refreshToken) {
    const message =
      res.status === 429
        ? "Too many attempts. Please wait a minute and try again."
        : Array.isArray(data.message)
          ? data.message.join(", ")
          : (data.message ?? "Login failed");
    return Response.json({ message }, { status: res.ok ? 500 : res.status });
  }

  await setSessionCookies({ accessToken: data.accessToken, refreshToken: data.refreshToken });
  return Response.json({ user: data.user });
}
