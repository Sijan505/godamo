const OFFICE_TEAM = ['OWNER', 'MANAGER', 'OFFICE'];

/** Sidebar entries and who may see them. */
export const NAV_ITEMS = [
  { label: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard', roles: OFFICE_TEAM },
  {
    label: 'Sales',
    href: '/sales',
    icon: 'ShoppingCart',
    roles: OFFICE_TEAM,
    children: [
      { label: 'Orders', href: '/sales/orders' },
      { label: 'Invoices', href: '/sales/invoices' },
    ],
  },
  { label: 'Purchases', href: '/purchases', icon: 'Truck', roles: [...OFFICE_TEAM, 'GODOWN'] },
  { label: 'Stock', href: '/stock', icon: 'Boxes', roles: [...OFFICE_TEAM, 'GODOWN'] },
  { label: 'Parties', href: '/parties', icon: 'Users', roles: OFFICE_TEAM },
  { label: 'Payments', href: '/payments', icon: 'Wallet', roles: OFFICE_TEAM },
  { label: 'Reports', href: '/reports', icon: 'BarChart3', roles: OFFICE_TEAM },
  { label: 'Settings', href: '/settings', icon: 'Settings', roles: ['OWNER', 'MANAGER'] },
];

/** Salesmen and drivers work in the mobile Field app, not the office web app. */
export const FIELD_ROLES = ['SALESMAN', 'DRIVER'];

export const ROLE_LABELS = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  OFFICE: 'Office',
  GODOWN: 'Godown',
  SALESMAN: 'Salesman',
  DRIVER: 'Driver',
};

export function navFor(role) {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

export const isActive = (pathname, href) => pathname === href || pathname.startsWith(`${href}/`);

/** Whether `role` may open `pathname` (based on the sidebar entries). */
export function canAccess(role, pathname) {
  return navFor(role).some((item) => isActive(pathname, item.href));
}

/** Where each role lands after login. */
export function landingPath(role) {
  return role === 'GODOWN' ? '/stock' : '/dashboard';
}

/** Only allow same-site relative paths as a post-login redirect (no open redirects). */
export function safeNextPath(next) {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  if (next.startsWith('/login') || next.startsWith('/api') || next.startsWith('/web-auth')) return null;
  return next;
}
