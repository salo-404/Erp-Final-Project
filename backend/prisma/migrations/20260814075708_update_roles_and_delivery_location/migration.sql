/*
  Warnings:

  - The values [MANAGER] on the enum `UserRole` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'EMPLOYEE');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "public"."UserRole_old";
COMMIT;

-- AlterTable
ALTER TABLE "InventoryTransaction" ADD COLUMN     "deliveryCountry" TEXT,
ADD COLUMN     "deliveryRegion" TEXT;

-- AlterTable
ALTER TABLE "PendingDocumentReview" ADD COLUMN     "extractedDeliveryCountry" TEXT,
ADD COLUMN     "extractedDeliveryRegion" TEXT,
ADD COLUMN     "extractedWarehouseName" TEXT;
