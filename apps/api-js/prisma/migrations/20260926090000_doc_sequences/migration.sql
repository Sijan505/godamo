-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('INVOICE', 'SALES_ORDER', 'SALES_RETURN');

-- DropForeignKey
ALTER TABLE "invoice_sequences" DROP CONSTRAINT "invoice_sequences_tenant_id_fkey";

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "line_no" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "price_source" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by_id" TEXT;

-- AlterTable
ALTER TABLE "sales_order_items" ADD COLUMN     "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "price_source" TEXT,
ADD COLUMN     "vat_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vat_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "invoice_sequences";

-- CreateTable
CREATE TABLE "doc_sequences" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "doc_type" "DocType" NOT NULL,
    "fiscal_year" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doc_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "doc_sequences_tenant_id_doc_type_fiscal_year_key" ON "doc_sequences"("tenant_id", "doc_type", "fiscal_year");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_sequences" ADD CONSTRAINT "doc_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

