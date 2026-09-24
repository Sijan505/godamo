const REQUIRED = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_EXPIRES',
  'JWT_REFRESH_EXPIRES_DAYS',
] as const;

// Fail fast at startup instead of on the first login.
export function validateEnv(config: Record<string, unknown>) {
  const missing = REQUIRED.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  if (!(Number(config.JWT_REFRESH_EXPIRES_DAYS) > 0)) {
    throw new Error('JWT_REFRESH_EXPIRES_DAYS must be a positive number');
  }
  return config;
}
