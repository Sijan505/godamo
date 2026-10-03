import 'dotenv/config';

const REQUIRED = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_EXPIRES',
  'JWT_REFRESH_EXPIRES_DAYS',
];

// Fail fast at startup instead of on the first login.
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}
if (!(Number(process.env.JWT_REFRESH_EXPIRES_DAYS) > 0)) {
  throw new Error('JWT_REFRESH_EXPIRES_DAYS must be a positive number');
}

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES,
  jwtRefreshExpiresDays: Number(process.env.JWT_REFRESH_EXPIRES_DAYS),
  port: Number(process.env.PORT ?? 4000),
  // Which proxies may set X-Forwarded-For: "loopback" (default), a hop count
  // such as "1" (one proxy in front, e.g. Vercel), "true", or addresses.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY ?? 'loopback'),
  production: process.env.NODE_ENV === 'production',
};
