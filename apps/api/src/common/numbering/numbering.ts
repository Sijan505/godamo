import { DocType, Prisma } from '../../generated/prisma/client.js';

/**
 * Next gap-free number for a document type in a tenant's fiscal year.
 *
 * One atomic upsert: the first call creates the row with 1, later calls
 * increment it. The row stays locked until the caller's transaction ends, so
 * concurrent documents wait for each other (no duplicates), and a rolled-back
 * document rolls its number back too (no gaps). Must run inside `tx`.
 */
export async function nextDocNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  docType: DocType,
  fiscalYear: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO doc_sequences (id, tenant_id, doc_type, fiscal_year, last_number, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${tenantId}, ${docType}::"DocType", ${fiscalYear}, 1, now(), now())
    ON CONFLICT (tenant_id, doc_type, fiscal_year)
    DO UPDATE SET last_number = doc_sequences.last_number + 1, updated_at = now()
    RETURNING last_number`;
  return Number(rows[0].last_number);
}

export function nextInvoiceNo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  fiscalYear: string,
) {
  return nextDocNumber(tx, tenantId, DocType.INVOICE, fiscalYear);
}

/** e.g. "SO-2083/84-00042" */
export async function nextSalesOrderNo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  fiscalYear: string,
) {
  const n = await nextDocNumber(tx, tenantId, DocType.SALES_ORDER, fiscalYear);
  return `SO-${fiscalYear}-${String(n).padStart(5, '0')}`;
}
