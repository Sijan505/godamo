"use client";

import { useQuery } from "@tanstack/react-query";
import { request } from "@/lib/api";
import type { Role } from "@/lib/navigation";

export interface Me {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  lastLoginAt: string | null;
  tenantId: string;
  tenantName: string;
  tenantCode: string;
}

/** The logged-in user (via the BFF, which refreshes the session when needed). */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => request<Me>("/api/auth/me"),
    staleTime: 5 * 60_000,
  });
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(
    () => undefined,
  );
  // Full page load on purpose: start clean without the old session/cache.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/login");
}
