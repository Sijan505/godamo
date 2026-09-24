"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/navigation";

const isActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/** Sidebar links. `collapsed` shows icons only (labels stay available to screen readers). */
export function SidebarNav({
  items,
  collapsed = false,
  onNavigate,
}: {
  items: NavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {items.map((item) =>
        item.children && !collapsed ? (
          <NavGroup key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
        ) : (
          <NavLink
            key={item.href}
            href={item.children ? item.children[0].href : item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(pathname, item.href)}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ),
      )}
    </nav>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: NavItem["icon"];
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-md px-3 py-2 text-[15px] font-medium text-sidebar-foreground/90 transition-colors outline-none",
        "hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-saffron",
        active && "bg-sidebar-active text-white shadow-[inset_3px_0_0_var(--saffron)]",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className={cn("size-5 shrink-0", active ? "text-saffron" : "text-sidebar-muted group-hover:text-white")} aria-hidden="true" />
      <span className={cn(collapsed && "sr-only")}>{label}</span>
    </Link>
  );
}

function NavGroup({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const groupActive = isActive(pathname, item.href);
  const [open, setOpen] = useState(true);
  const Icon = item.icon;
  const listId = `nav-group-${item.href.slice(1)}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "group flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[15px] font-medium text-sidebar-foreground/90 transition-colors outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-saffron",
          groupActive && "text-white",
        )}
      >
        <Icon className={cn("size-5 shrink-0", groupActive ? "text-saffron" : "text-sidebar-muted group-hover:text-white")} aria-hidden="true" />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={listId} className="mt-1 ml-5 flex flex-col gap-0.5 border-l border-white/15 pl-3">
          {item.children!.map((child) => {
            const active = isActive(pathname, child.href);
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-3 py-1.5 text-sm text-sidebar-foreground/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-saffron",
                    active && "bg-sidebar-active font-medium text-white",
                  )}
                >
                  {child.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
