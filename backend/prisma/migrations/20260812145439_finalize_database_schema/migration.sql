/*
  Warnings:

  - You are about to drop the column `approvedAt` on the `InventoryTransaction` table. All the data in the column will be lost.
  - You are about to drop the column `approvedById` on the `InventoryTransaction` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "InventoryTransaction" DROP CONSTRAINT "InventoryTransaction_approvedById_fkey";

-- AlterTable
ALTER TABLE "InventoryTransaction" DROP COLUMN "approvedAt",
DROP COLUMN "approvedById";
