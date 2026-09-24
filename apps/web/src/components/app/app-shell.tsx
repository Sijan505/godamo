"use client";

import { PanelLeftClose, PanelLeftOpen, RotateCw, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { GodamoLogo } from "@/components/brand/godamo-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { landingPath } from "@/lib/auth-cookies";
import { canAccess, FIELD_ROLES, navFor } from "@/lib/navigation";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { FieldAppNotice } from "./field-app-notice";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";

const COLLAPSE_KEY = "godamo.sidebarCollapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false; // storage blocked
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Remember the collapsed sidebar per browser (a convenience only). The
  // shell renders only after the user loads on the client, so reading
  // localStorage here cannot cause a hydration mismatch.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // storage blocked: ignore
      }
      return !c;
    });
  };

  if (me.isPending) return <ShellSkeleton />;
  if (me.isError || !me.data) {
    // 401 already redirected to /login; anything else gets a retry.
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4 text-center">
        <p className="text-muted-foreground">We could not load your account.</p>
        <Button onClick={() => void me.refetch()}>
          <RotateCw aria-hidden="true" /> Try again
        </Button>
      </main>
    );
  }

  const user = me.data;
  if (FIELD_ROLES.includes(user.role)) return <FieldAppNotice me={user} />;

  const items = navFor(user.role);
  const allowed = canAccess(user.role, pathname);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      {/* Desktop / large-tablet sidebar */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex",
          collapsed ? "w-[72px]" : "w-60",
        )}
      >
        <div className={cn("flex h-16 items-center border-b border-white/10", collapsed ? "justify-center" : "px-5")}>
          <Link href={landingPath(user.role)} className="rounded-md text-white outline-none focus-visible:ring-2 focus-visible:ring-saffron" aria-label="Godamo home">
            <GodamoLogo showWordmark={!collapsed} />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav items={items} collapsed={collapsed} />
        </div>
        <div className="border-t border-white/10 p-3">
          <Button
            variant="ghost"
            onClick={toggleCollapsed}
            className={cn(
              "w-full text-sidebar-muted hover:bg-white/10 hover:text-white",
              collapsed ? "justify-center px-0" : "justify-start",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {collapsed ? null : <span>Collapse</span>}
          </Button>
        </div>
      </aside>

      {/* Phone / tablet drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-none bg-sidebar p-0 text-sidebar-foreground [&>button]:text-white">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <div className="flex h-16 items-center border-b border-white/10 px-5 text-white">
            <GodamoLogo />
          </div>
          <div className="overflow-y-auto px-3 py-4">
            <SidebarNav items={items} onNavigate={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar me={user} onOpenMenu={() => setMobileOpen(true)} />
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8">
          {allowed ? children : <NoAccess home={landingPath(user.role)} />}
        </main>
      </div>
    </div>
  );
}

function NoAccess({ home }: { home: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning">
        <ShieldAlert className="size-6" aria-hidden="true" />
      </span>
      <h1 className="text-xl font-semibold">This page is not available for your role</h1>
      <p className="text-muted-foreground">Ask your owner or manager if you need access.</p>
      <Button asChild>
        <Link href={home}>Go to my home page</Link>
      </Button>
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="hidden w-60 shrink-0 bg-sidebar lg:block" />
      <div className="flex-1">
        <div className="flex h-16 items-center gap-4 border-b bg-card px-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="ml-auto size-8 rounded-full" />
        </div>
        <div className="grid gap-4 p-6 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl bg-card" />
          ))}
        </div>
      </div>
    </div>
  );
}
