import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsRoutes } from './accounts/settings.js';
import { authRoutes } from './auth/auth.js';
import { hasWebSession, webSessionRouter } from './auth/web-session.js';
import { categoriesRoutes } from './categories/categories.js';
import { config } from './config.js';
import { creditRoutes } from './credit/credit.js';
import { dashboardRoutes } from './dashboard/dashboard.js';
import { prisma } from './db.js';
import { godownsRoutes } from './godowns/godowns.js';
import { handoversRoutes } from './handovers/handovers.js';
import { controller, errorHandler, notFoundHandler } from './http/router.js';
import { invoicesRoutes } from './invoices/invoices.js';
import { partiesRoutes } from './parties/parties.js';
import { partyAccountsRoutes } from './party-accounts/party-accounts.js';
import { paymentsRoutes } from './payments/payments.js';
import { pricingRoutes } from './pricing/pricing.js';
import { productImportRoutes } from './products/product-import.js';
import { productsRoutes } from './products/products.js';
import { purchasesRoutes } from './purchases/purchases.js';
import { reportsRoutes } from './reports/reports.js';
import { salesOrdersRoutes } from './sales-orders/sales-orders.js';
import { stockRoutes } from './stock/stock-routes.js';
import { usersRoutes } from './users/users.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web-html');

const health = controller('/health');
health.get('/', { public: true }, async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'ok', time: new Date().toISOString() };
});

// Order matters where paths overlap (e.g. /products/import before /products/:id).
const API_ROUTES = [
  authRoutes,
  usersRoutes,
  categoriesRoutes,
  ...pricingRoutes,
  productImportRoutes,
  productsRoutes,
  partiesRoutes,
  godownsRoutes,
  stockRoutes,
  purchasesRoutes,
  ...creditRoutes,
  salesOrdersRoutes,
  invoicesRoutes,
  settingsRoutes,
  paymentsRoutes,
  handoversRoutes,
  partyAccountsRoutes,
  reportsRoutes,
  dashboardRoutes,
  health,
];

/** Office web app pages; each is served by app.html, which draws the page. */
const APP_PAGES = [
  '/dashboard',
  '/sales/orders',
  '/sales/invoices',
  '/purchases',
  '/stock',
  '/parties',
  '/payments',
  '/reports',
  '/settings',
];

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // The web app sends the browser's IP via a proxy we control (default: same
  // machine). Trust X-Forwarded-For only from there, so per-IP rate limits
  // (e.g. 5 logins/minute) apply per browser.
  app.set('trust proxy', config.trustProxy);
  app.use(express.json());

  // ─── API ────────────────────────────────────────────────────────────────
  const api = express.Router();
  for (const c of API_ROUTES) api.use(c.prefix, c.router);
  app.use('/api/v1', api);
  app.use('/web-auth', webSessionRouter());
  app.use(['/api', '/web-auth'], notFoundHandler);

  // ─── Web app ────────────────────────────────────────────────────────────
  const sendPage = (name) => (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.sendFile(path.join(WEB_DIR, name));
  };
  // Everything except /login needs a session; logged-in users skip /login.
  // Whether the tokens are still valid is checked by the API itself.
  const needSession = (req, res, next) => {
    if (hasWebSession(req)) return next();
    const next_ = req.path === '/' ? '' : `?next=${encodeURIComponent(req.originalUrl)}`;
    res.redirect(302, `/login${next_}`);
  };

  app.get('/login', (req, res, next) =>
    hasWebSession(req) ? res.redirect(302, '/dashboard') : sendPage('login.html')(req, res, next),
  );
  app.get('/', needSession, (_req, res) => res.redirect(302, '/dashboard'));
  app.get('/sales', needSession, (_req, res) => res.redirect(302, '/sales/orders'));
  app.get(APP_PAGES, needSession, sendPage('app.html'));
  app.use(express.static(WEB_DIR, { index: false, extensions: [] }));
  // Unknown pages: the app shell shows "Page not found".
  app.get('/{*path}', needSession, (req, res, next) => {
    res.status(404);
    sendPage('app.html')(req, res, next);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
