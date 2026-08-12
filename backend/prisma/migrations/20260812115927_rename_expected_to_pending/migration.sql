/*
  Warnings:

  - The values [EXPECTED] on the enum `InventoryTransactionStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "InventoryTransactionStatus_new" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');
ALTER TABLE "public"."InventoryTransaction" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "InventoryTransaction" ALTER COLUMN "status" TYPE "InventoryTransactionStatus_new" USING ("status"::text::"InventoryTransactionStatus_new");
ALTER TYPE "InventoryTransactionStatus" RENAME TO "InventoryTransactionStatus_old";
ALTER TYPE "InventoryTransactionStatus_new" RENAME TO "InventoryTransactionStatus";
DROP TYPE "public"."InventoryTransactionStatus_old";
ALTER TABLE "InventoryTransaction" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "InventoryTransaction" ALTER COLUMN "status" SET DEFAULT 'PENDING';
