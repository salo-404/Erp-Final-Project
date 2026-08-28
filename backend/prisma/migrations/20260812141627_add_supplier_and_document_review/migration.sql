-- CreateEnum
CREATE TYPE "DocumentReviewStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "InventoryTransaction" ADD COLUMN     "supplierId" INTEGER;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingDocumentReview" (
    "id" SERIAL NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "transactionType" "InventoryTransactionType" NOT NULL,
    "extractedPartyName" TEXT,
    "extractedSupplierName" TEXT,
    "extractedDate" TIMESTAMP(3),
    "extractedItems" JSONB NOT NULL,
    "status" "DocumentReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "transactionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingDocumentReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PendingDocumentReview_transactionId_key" ON "PendingDocumentReview"("transactionId");

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingDocumentReview" ADD CONSTRAINT "PendingDocumentReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingDocumentReview" ADD CONSTRAINT "PendingDocumentReview_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "InventoryTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
