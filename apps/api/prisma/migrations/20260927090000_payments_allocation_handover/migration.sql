-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- CreateEnum
CREATE TYPE "ChequeStatus" AS ENUM ('PENDING', 'CLEARED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('SUBMITTED', 'VERIFIED', 'DISPUTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocType" ADD VALUE 'RECEIPT';
ALTER TYPE "DocType" ADD VALUE 'SUPPLIER_PAYMENT';
ALTER TYPE "DocType" ADD VALUE 'HANDOVER';

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_reversal_of_id_fkey";

-- DropIndex
DROP INDEX "payments_reversal_of_id_key";

-- AlterTable
ALTER TABLE "payments" DROP COLUMN "reversal_of_id",
ADD COLUMN     "cheque_bank" TEXT,
ADD COLUMN     "cheque_date" DATE,
ADD COLUMN     "cheque_no" TEXT,
ADD COLUMN     "cheque_status" "ChequeStatus",
ADD COLUMN     "collected_by_id" TEXT NOT NULL,
ADD COLUMN     "fiscal_year" TEXT NOT NULL,
ADD COLUMN     "handover_id" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "receipt_no" INTEGER NOT NULL,
ADD COLUMN     "reversal_reason" TEXT,
ADD COLUMN     "reversed_at" TIMESTAMP(3),
ADD COLUMN     "reversed_by_id" TEXT,
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_handovers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "handover_no" TEXT NOT NULL,
    "from_user_id" TEXT NOT NULL,
    "received_by_id" TEXT,
    "expected_amount" DECIMAL(14,2) NOT NULL,
    "received_amount" DECIMAL(14,2),
    "difference" DECIMAL(14,2),
    "status" "HandoverStatus" NOT NULL DEFAULT 'SUBMITTED',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenant_id" TEXT NOT NULL,
    "overdue_grace_days" INTEGER NOT NULL DEFAULT 7,
    "block_on_overdue" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE INDEX "payment_allocations_invoice_id_idx" ON "payment_allocations"("invoice_id");

-- CreateIndex
CREATE INDEX "payment_allocations_payment_id_idx" ON "payment_allocations"("payment_id");

-- CreateIndex
CREATE INDEX "payment_allocations_tenant_id_idx" ON "payment_allocations"("tenant_id");

-- CreateIndex
CREATE INDEX "cash_handovers_tenant_id_status_idx" ON "cash_handovers"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "cash_handovers_tenant_id_from_user_id_idx" ON "cash_handovers"("tenant_id", "from_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_handovers_tenant_id_handover_no_key" ON "cash_handovers"("tenant_id", "handover_no");

-- CreateIndex
CREATE INDEX "payments_tenant_id_collected_by_id_handover_id_idx" ON "payments"("tenant_id", "collected_by_id", "handover_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_direction_fiscal_year_receipt_no_key" ON "payments"("tenant_id", "direction", "fiscal_year", "receipt_no");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_collected_by_id_fkey" FOREIGN KEY ("collected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "cash_handovers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

