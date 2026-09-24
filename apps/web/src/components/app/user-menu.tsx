"use client";

import { ChevronDown, KeyRound, LogOut } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABELS } from "@/lib/navigation";
import { logout, type Me } from "@/lib/session";
import { ChangePasswordDialog } from "./change-password-dialog";

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function UserMenu({ me }: { me: Me }) {
  const [changing, setChanging] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-10 gap-2 px-2" aria-label={`Account menu for ${me.name}`}>
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
            >
              {initials(me.name)}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-sm font-medium">{me.name}</span>
              <span className="block text-xs text-muted-foreground">{ROLE_LABELS[me.role]}</span>
            </span>
            <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <span className="block font-medium">{me.name}</span>
            <span className="block text-xs text-muted-foreground">{me.phone}</span>
            <Badge variant="secondary" className="mt-2">
              {ROLE_LABELS[me.role]}
            </Badge>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setChanging(true)}>
            <KeyRound aria-hidden="true" /> Change password
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
            <LogOut aria-hidden="true" /> Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={changing} onOpenChange={setChanging} />
    </>
  );
}
