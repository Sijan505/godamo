import { cookies } from "next/headers";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth-cookies";
import { apiUrl, clearSessionCookies, clientHeaders } from "@/lib/server/backend";

/** POST /api/auth/logout: revokes the refresh token on the API (best effort) and clears the cookies. */
export async function POST() {
  const jar = await cookies();
  const access = jar.get(ACCESS_COOKIE)?.value;
  const refresh = jar.get(REFRESH_COOKIE)?.value;

  if (access && refresh) {
    await fetch(apiUrl("/auth/logout"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access}`,
        ...(await clientHeaders()),
      },
      body: JSON.stringify({ refreshToken: refresh }),
      cache: "no-store",
    }).catch(() => undefined);
  }

  await clearSessionCookies();
  return new Response(null, { status: 204 });
}
