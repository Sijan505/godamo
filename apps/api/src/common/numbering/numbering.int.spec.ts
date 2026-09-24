import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { nextInvoiceNo, nextSalesOrderNo } from './numbering.js';

// Integration test: needs the real PostgreSQL database from .env. It works on a
// throw-away tenant and removes it afterwards.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('document numbering (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let tenantId: string;
  const FY = '2083/84';

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url! }),
    });
    const tenant = await prisma.tenant.create({
      data: {
        code: `ZZTEST${randomBytes(4).toString('hex').toUpperCase()}`,
        name: 'Numbering test tenant',
      },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.docSequence.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('20 parallel invoices get 20 unique, consecutive numbers', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.$transaction(async (tx) => {
          const n = await nextInvoiceNo(tx, tenantId, FY);
          // Hold the transaction open briefly, like a real invoice would.
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          return n;
        }),
      ),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  }, 60_000);

  it('a rolled-back invoice does not leave a gap', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await nextInvoiceNo(tx, tenantId, FY);
        throw new Error('invoice failed (e.g. not enough stock)');
      }),
    ).rejects.toThrow('invoice failed');

    const next = await prisma.$transaction((tx) =>
      nextInvoiceNo(tx, tenantId, FY),
    );
    expect(next).toBe(21);
  });

  it('numbers each document type and fiscal year separately', async () => {
    const [order, otherYear] = await prisma.$transaction(async (tx) => [
      await nextSalesOrderNo(tx, tenantId, FY),
      await nextInvoiceNo(tx, tenantId, '2084/85'),
    ]);
    expect(order).toBe('SO-2083/84-00001');
    expect(otherYear).toBe(1);
  });
});
