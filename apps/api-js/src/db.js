import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './config.js';
import { Prisma, PrismaClient } from './generated/prisma/index.js';

export * from './generated/prisma/index.js';

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
});

export const { Decimal } = Prisma;

/** True when a write failed on a unique constraint (Prisma P2002). */
export function isUniqueViolation(e) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
