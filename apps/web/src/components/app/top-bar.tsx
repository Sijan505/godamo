"use client";

import { Menu } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatAD, isoToBSLongNepali, nepalTodayISO } from "@/lib/nepali-date";
import type { Me } from "@/lib/session";
import { cn } from "@/lib/utils";
import { UserMenu } from "./user-menu";

export function TopBar({ me, onOpenMenu }: { me: Me; onOpenMenu: () => void }) {
  const today = useMemo(() => nepalTodayISO(), []);
  const [lang, setLang] = useState<"en" | "ne">("en");

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenMenu}
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </Button>

      <div className="min-w-0 flex-1">
        <p className="truncate font-heading text-base font-semibold text-primary sm:text-lg">
          {me.tenantName}
        </p>
        <p className="truncate text-xs text-muted-foreground sm:text-sm">
          <span lang="ne" className="font-medium text-nepali">
            {isoToBSLongNepali(today)}
          </span>
          <span aria-hidden="true"> · </span>
          <span>{formatAD(today)}</span>
        </p>
      </div>

      {/* Language toggle (placeholder until the Nepali UI lands) */}
      <div role="group" aria-label="Language" className="hidden items-center rounded-md border bg-muted p-0.5 sm:flex">
        {(
          [
            ["en", "EN"],
            ["ne", "नेपाली"],
          ] as const
        ).map(([code, label]) => (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={lang === code}
            onClick={() => {
              setLang(code);
              if (code === "ne") toast.info("नेपाली भाषा छिट्टै आउँदैछ। (Nepali interface coming soon.)");
            }}
            className={cn(
              "cursor-pointer rounded px-2.5 py-1 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              lang === code ? "bg-card text-primary shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <UserMenu me={me} />
    </header>
  );
}
