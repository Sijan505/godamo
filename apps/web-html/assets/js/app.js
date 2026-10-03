/**
 * The office web app shell: sidebar, top bar and user menu around the page
 * for the current path. Links inside the app switch pages without a reload.
 */
import { ApiError, apiFetch, getMe, logout } from './api.js';
import { esc } from './format.js';
import { icon } from './icons.js';
import { formatAD, isoToBSLongNepali, nepalTodayISO } from './nepali-date.js';
import { FIELD_ROLES, ROLE_LABELS, canAccess, isActive, landingPath, navFor } from './navigation.js';
import { renderDashboard } from './pages/dashboard.js';
import { logo, openDialog, toast, trapFocus } from './ui.js';

const COLLAPSE_KEY = 'godamo.sidebarCollapsed';
const root = document.getElementById('root');

/** Page title (for <title>) and how to draw each page. */
const PAGES = {
  '/dashboard': { title: 'Dashboard', render: renderDashboard },
  '/sales/orders': comingSoon('Sales orders', 'Book, confirm and track orders from salesmen and the office.'),
  '/sales/invoices': comingSoon('Invoices', 'Issue VAT invoices, print them and see what is paid or overdue.'),
  '/purchases': comingSoon('Purchases', 'Enter supplier bills; stock and the supplier ledger update automatically.'),
  '/stock': comingSoon('Stock', 'Stock by godown, transfers, adjustments, counts and expiry.'),
  '/parties': comingSoon('Parties', 'Customers and suppliers, credit limits, ledgers and reminders.'),
  '/payments': comingSoon('Payments', 'Receipts, cheques, supplier payments and cash handovers.'),
  '/reports': comingSoon('Reports', 'Ageing, outstanding, collections and stock reports.'),
  '/settings': comingSoon('Settings', 'Company, users, price tiers and credit-control settings.'),
};

let me = null;
let cleanupPage = null;

// ─── Start ──────────────────────────────────────────────────────────────────

async function start() {
  try {
    me = await getMe();
  } catch (e) {
    // 401 already went to /login; anything else gets a retry.
    if (e instanceof ApiError && e.status === 401) return;
    root.innerHTML = `
      <main class="center-screen">
        <p class="muted">We could not load your account.</p>
        <button type="button" class="btn btn-primary" id="retry">${icon('RotateCw')} Try again</button>
      </main>`;
    root.querySelector('#retry').addEventListener('click', () => {
      window.location.reload();
    });
    return;
  }
  if (FIELD_ROLES.includes(me.role)) return renderFieldAppNotice();
  if (window.location.pathname === '/sales') history.replaceState(null, '', '/sales/orders');
  renderShell();
  renderPage();
}

// ─── Shell ──────────────────────────────────────────────────────────────────

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false; // storage blocked
  }
}

function renderShell() {
  const today = nepalTodayISO();
  root.innerHTML = `
    <div class="shell">
      <a href="#main" class="skip-link">Skip to content</a>

      <aside class="sidebar${readCollapsed() ? ' collapsed' : ''}" id="sidebar">
        <div class="sidebar-head">
          <a href="${landingPath(me.role)}" data-link aria-label="Godamo home" id="home-link"></a>
        </div>
        <div class="sidebar-body" id="nav-desktop"></div>
        <div class="sidebar-foot">
          <button type="button" class="btn btn-ghost collapse-btn" id="collapse"></button>
        </div>
      </aside>

      <div class="main-col">
        <header class="topbar">
          <button type="button" class="btn btn-ghost btn-icon menu-btn" id="open-menu" aria-label="Open menu">${icon('Menu', 'size-5')}</button>
          <div class="topbar-title">
            <p class="tenant truncate">${esc(me.tenantName)}</p>
            <p class="date truncate">
              <span lang="ne" class="nepali font-medium">${esc(isoToBSLongNepali(today))}</span><span aria-hidden="true"> · </span><span>${esc(formatAD(today))}</span>
            </p>
          </div>
          <!-- Language toggle (placeholder until the Nepali UI lands) -->
          <div role="group" aria-label="Language" class="lang-toggle">
            <button type="button" lang="en" aria-pressed="true" data-lang="en">EN</button>
            <button type="button" lang="ne" aria-pressed="false" data-lang="ne">नेपाली</button>
          </div>
          <div class="user-menu" id="user-menu">
            <button type="button" class="btn btn-ghost user-btn" id="user-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu for ${esc(me.name)}">
              <span class="avatar" aria-hidden="true">${esc(initials(me.name))}</span>
              <span class="who">
                <span class="font-medium" style="font-size: 0.875rem">${esc(me.name)}</span>
                <span class="muted" style="font-size: 0.75rem">${esc(ROLE_LABELS[me.role])}</span>
              </span>
              ${icon('ChevronDown', 'muted')}
            </button>
          </div>
        </header>
        <main id="main" tabindex="-1" class="page"></main>
      </div>
    </div>`;

  drawSidebar();
  root.querySelector('#collapse').addEventListener('click', () => {
    const sidebar = root.querySelector('#sidebar');
    const collapsed = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', collapsed);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // storage blocked: ignore
    }
    drawSidebar();
  });
  root.querySelector('#open-menu').addEventListener('click', openDrawer);
  root.querySelectorAll('[data-lang]').forEach((btn) =>
    btn.addEventListener('click', () => {
      root.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      if (btn.dataset.lang === 'ne') toast('नेपाली भाषा छिट्टै आउँदैछ। (Nepali interface coming soon.)');
    }),
  );
  setupUserMenu();
}

function drawSidebar() {
  const collapsed = root.querySelector('#sidebar').classList.contains('collapsed');
  root.querySelector('#home-link').innerHTML = logo({ wordmark: !collapsed });
  root.querySelector('#nav-desktop').innerHTML = navMarkup(collapsed);
  const btn = root.querySelector('#collapse');
  btn.innerHTML = collapsed ? icon('PanelLeftOpen') : `${icon('PanelLeftClose')}<span>Collapse</span>`;
  btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  btn.setAttribute('aria-expanded', String(!collapsed));
  applyGroups();
}

/** Sidebar links. `collapsed` shows icons only (labels stay available to screen readers). */
function navMarkup(collapsed, idPrefix = 'nav') {
  const path = window.location.pathname;
  const items = navFor(me.role)
    .map((item) => {
      if (item.children && !collapsed) {
        const groupActive = isActive(path, item.href);
        const listId = `${idPrefix}-group-${item.href.slice(1)}`;
        return `<div>
          <button type="button" class="nav-group-btn${groupActive ? ' active' : ''}" aria-expanded="true" aria-controls="${listId}" data-group>
            ${icon(item.icon)}<span>${esc(item.label)}</span>${icon('ChevronDown', 'chevron')}
          </button>
          <ul class="nav-sub" id="${listId}">
            ${item.children
              .map(
                (c) =>
                  `<li><a href="${c.href}" data-link${isActive(path, c.href) ? ' aria-current="page"' : ''}>${esc(c.label)}</a></li>`,
              )
              .join('')}
          </ul>
        </div>`;
      }
      const href = item.children ? item.children[0].href : item.href;
      return `<a href="${href}" data-link class="nav-link"${isActive(path, item.href) ? ' aria-current="page"' : ''}${collapsed ? ` title="${esc(item.label)}"` : ''}>
        ${icon(item.icon)}<span${collapsed ? ' class="sr-only"' : ''}>${esc(item.label)}</span>
      </a>`;
    })
    .join('');
  return `<nav aria-label="Main" class="nav">${items}</nav>`;
}

// Group open/closed and current-page marks survive page changes.
const closedGroups = new Set();
function refreshNav() {
  const desktop = root.querySelector('#nav-desktop');
  if (desktop) desktop.innerHTML = navMarkup(root.querySelector('#sidebar').classList.contains('collapsed'));
  const drawerNav = document.querySelector('#nav-drawer');
  if (drawerNav) drawerNav.innerHTML = navMarkup(false, 'drawer');
  applyGroups();
}
function applyGroups() {
  document.querySelectorAll('[data-group]').forEach((btn) => {
    const list = document.getElementById(btn.getAttribute('aria-controls'));
    const open = !closedGroups.has(btn.getAttribute('aria-controls').replace(/^(nav|drawer)-/, ''));
    btn.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
  });
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-group]');
  if (!btn) return;
  const key = btn.getAttribute('aria-controls').replace(/^(nav|drawer)-/, '');
  if (closedGroups.has(key)) closedGroups.delete(key);
  else closedGroups.add(key);
  applyGroups();
});

function openDrawer() {
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'Menu');
  drawer.innerHTML = `
    <p class="sr-only">Main navigation</p>
    <div class="sidebar-head" style="color: #fff">${logo()}</div>
    <div class="sidebar-body" id="nav-drawer">${navMarkup(false, 'drawer')}</div>
    <button type="button" class="drawer-close" data-close>${icon('X')}<span class="sr-only">Close</span></button>`;
  const close = () => {
    overlay.remove();
    drawer.remove();
    document.removeEventListener('keydown', onKey);
    opener?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') trapFocus(drawer, e);
  };
  overlay.addEventListener('click', close);
  drawer.addEventListener('click', (e) => {
    if (e.target.closest('[data-close], a[data-link]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay, drawer);
  applyGroups();
  drawer.querySelector('a, button')?.focus();
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function setupUserMenu() {
  const wrap = root.querySelector('#user-menu');
  const btn = wrap.querySelector('#user-btn');
  let menu = null;
  const close = (focusButton = false) => {
    menu?.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside);
    if (focusButton) btn.focus();
  };
  const onOutside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  const open = () => {
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="menu-label">
        <span class="font-medium" style="display: block">${esc(me.name)}</span>
        <span class="muted" style="display: block; font-size: 0.75rem">${esc(me.phone)}</span>
        <span class="badge badge-secondary" style="margin-top: 0.5rem">${esc(ROLE_LABELS[me.role])}</span>
      </div>
      <div class="menu-sep" role="separator"></div>
      <button type="button" class="menu-item" role="menuitem" data-action="password">${icon('KeyRound')} Change password</button>
      <button type="button" class="menu-item danger" role="menuitem" data-action="logout">${icon('LogOut')} Log out</button>`;
    wrap.append(menu);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside);
    menu.querySelector('.menu-item').focus();
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.menu-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') close(true);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(i + 1) % items.length].focus();
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i - 1 + items.length) % items.length].focus();
      }
      if (e.key === 'Tab') close();
    });
    menu.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      close();
      if (action === 'password') openChangePassword();
      if (action === 'logout') void logout();
    });
  };
  btn.addEventListener('click', () => (menu ? close() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !menu) {
      e.preventDefault();
      open();
    }
  });
}

/** Change password; the API logs out every session, so we log in again afterwards. */
function openChangePassword() {
  const { root: box } = openDialog(
    `<div class="dialog-head">
      <h2 class="dialog-title" id="cp-title">Change password</h2>
      <p class="dialog-desc">You will be logged out on all devices and asked to log in again.</p>
    </div>
    <form class="form-grid" novalidate id="cp-form">
      <p class="form-error" role="alert" id="cp-error" hidden></p>
      ${passwordField('currentPassword', 'Current password', 'current-password')}
      ${passwordField('newPassword', 'New password', 'new-password')}
      ${passwordField('confirmPassword', 'Confirm new password', 'new-password')}
      <div class="dialog-foot">
        <button type="button" class="btn btn-outline" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary" id="cp-submit">Change password</button>
      </div>
    </form>`,
    { label: 'cp-title' },
  );
  const form = box.querySelector('#cp-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const errors = {};
    if (!v.currentPassword) errors.currentPassword = 'Enter your current password';
    if (v.newPassword.length < 8) errors.newPassword = 'Use at least 8 characters';
    else if (v.newPassword.length > 72) errors.newPassword = 'Too long';
    if (v.newPassword !== v.confirmPassword) errors.confirmPassword = 'Passwords do not match';
    for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) {
      const input = form.elements[name];
      const err = box.querySelector(`#cp-${name}-err`);
      err.hidden = !errors[name];
      err.textContent = errors[name] ?? '';
      input.setAttribute('aria-invalid', errors[name] ? 'true' : 'false');
    }
    const firstBad = ['currentPassword', 'newPassword', 'confirmPassword'].find((n) => errors[n]);
    if (firstBad) return form.elements[firstBad].focus();

    const errorBox = box.querySelector('#cp-error');
    const submit = box.querySelector('#cp-submit');
    errorBox.hidden = true;
    submit.disabled = true;
    submit.innerHTML = `${icon('Loader2', 'spin')} Change password`;
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: v.currentPassword, newPassword: v.newPassword }),
      });
    } catch (err) {
      errorBox.textContent = err instanceof ApiError ? err.message : 'Could not change the password';
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Change password';
      return;
    }
    toast('Password changed. Please log in with your new password.', { type: 'success' });
    await logout();
  });
}

function passwordField(name, label, autocomplete) {
  return `<div class="field">
    <label class="label" for="cp-${name}">${label}</label>
    <input class="input" id="cp-${name}" name="${name}" type="password" autocomplete="${autocomplete}" aria-describedby="cp-${name}-err" />
    <p class="field-error" id="cp-${name}-err" hidden></p>
  </div>`;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

function renderPage() {
  cleanupPage?.();
  cleanupPage = null;
  const main = root.querySelector('#main');
  const path = window.location.pathname;
  const page = PAGES[path];

  if (!page) {
    document.title = 'Page not found · Godamo';
    main.innerHTML = notFound();
    return;
  }
  if (!canAccess(me.role, path)) {
    document.title = `${page.title} · Godamo`;
    main.innerHTML = noAccess();
    return;
  }
  document.title = `${page.title} · Godamo`;
  cleanupPage = page.render(main) ?? null;
}

function noAccess() {
  return `<div class="notice">
    <span class="icon-circle warning">${icon('ShieldAlert', 'size-6')}</span>
    <h1>This page is not available for your role</h1>
    <p class="muted">Ask your owner or manager if you need access.</p>
    <a href="${landingPath(me.role)}" data-link class="btn btn-primary">Go to my home page</a>
  </div>`;
}

function notFound() {
  return `<div class="notice">
    <h1>Page not found</h1>
    <p class="muted">The page you are looking for does not exist.</p>
    <a href="${landingPath(me.role)}" data-link class="btn btn-primary">Go to my home page</a>
  </div>`;
}

/** Placeholder for sections that arrive in a later step. */
function comingSoon(title, description) {
  return {
    title,
    render(main) {
      main.innerHTML = `<div class="page-inner narrow">
        <h1 class="page-title">${esc(title)}</h1>
        <div class="card">
          <div class="card-content coming-soon">
            <span class="icon-circle secondary">${icon('Construction', 'size-6')}</span>
            <p class="title">Coming in the next step</p>
            <p class="muted">${esc(description)}</p>
          </div>
        </div>
      </div>`;
    },
  };
}

/** Salesmen and drivers work in the mobile Field app, not the office web app. */
function renderFieldAppNotice() {
  document.title = 'Godamo';
  root.innerHTML = `
    <main class="center-screen">
      <div class="card field-card">
        <div class="card-content">
          <span style="color: var(--primary)">${logo({ markClass: 'lg' })}</span>
          <span class="icon-circle lg secondary">${icon('Smartphone', 'size-7')}</span>
          <div class="stack">
            <h1>Namaste, ${esc(me.name)}!</h1>
            <p class="muted">You are logged in as <strong>${esc(ROLE_LABELS[me.role])}</strong>. Please use the
              <strong>Godamo Field app</strong> on your phone for orders, deliveries and collections.</p>
            <p lang="ne" class="nepali">कृपया अर्डर, डेलिभरी र सङ्कलनका लागि फोनमा गोदामो फिल्ड एप प्रयोग गर्नुहोस्।</p>
          </div>
          <button type="button" class="btn btn-outline" id="logout">${icon('LogOut')} Log out</button>
        </div>
      </div>
    </main>`;
  root.querySelector('#logout').addEventListener('click', () => void logout());
}

// ─── In-app navigation ──────────────────────────────────────────────────────

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  e.preventDefault();
  const target = url.pathname === '/sales' ? '/sales/orders' : url.pathname;
  if (target !== window.location.pathname) history.pushState(null, '', target);
  refreshNav();
  renderPage();
  root.querySelector('#main')?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

window.addEventListener('popstate', () => {
  if (!me || FIELD_ROLES.includes(me.role)) return;
  refreshNav();
  renderPage();
});

start();
