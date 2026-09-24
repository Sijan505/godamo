import { Prisma } from '../generated/prisma/client.js';

/** True when a write failed on a unique constraint (Prisma P2002). */
export function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}
