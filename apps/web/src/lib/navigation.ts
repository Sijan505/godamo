import {
  BarChart3,
  Boxes,
  LayoutDashboard,
  type LucideIcon,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
} from "lucide-react";

export type Role = "OWNER" | "MANAGER" | "OFFICE" | "GODOWN" | "SALESMAN" | "DRIVER";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  roles: Role[];
  children?: { label: string; href: string }[];
}

const OFFICE_TEAM: Role[] = ["OWNER", "MANAGER", "OFFICE"];

/** Sidebar entries and who may see them. */
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: OFFICE_TEAM },
  {
    label: "Sales",
    href: "/sales",
    icon: ShoppingCart,
    roles: OFFICE_TEAM,
    children: [
      { label: "Orders", href: "/sales/orders" },
      { label: "Invoices", href: "/sales/invoices" },
    ],
  },
  { label: "Purchases", href: "/purchases", icon: Truck, roles: [...OFFICE_TEAM, "GODOWN"] },
  { label: "Stock", href: "/stock", icon: Boxes, roles: [...OFFICE_TEAM, "GODOWN"] },
  { label: "Parties", href: "/parties", icon: Users, roles: OFFICE_TEAM },
  { label: "Payments", href: "/payments", icon: Wallet, roles: OFFICE_TEAM },
  { label: "Reports", href: "/reports", icon: BarChart3, roles: OFFICE_TEAM },
  { label: "Settings", href: "/settings", icon: Settings, roles: ["OWNER", "MANAGER"] },
];

export const FIELD_ROLES: Role[] = ["SALESMAN", "DRIVER"];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  OFFICE: "Office",
  GODOWN: "Godown",
  SALESMAN: "Salesman",
  DRIVER: "Driver",
};

export function navFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/** Whether `role` may open `pathname` (based on the sidebar entries). */
export function canAccess(role: Role, pathname: string): boolean {
  return navFor(role).some(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}

