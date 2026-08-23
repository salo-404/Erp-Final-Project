import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { S3DocumentStorageService } from '../document-review/s3-document-storage.service';
import { InventoryTransactionsController } from './inventory-transactions.controller';
import { InventoryTransactionsService } from './inventory-transactions.service';

@Module({
  imports: [ReservationsModule, StockMovementsModule],
  controllers: [InventoryTransactionsController],
  // S3DocumentStorageService is provided here directly (not imported from
  // DocumentReviewModule) — that module already imports
  // InventoryTransactionsModule, so importing DocumentReviewModule here
  // would create a circular module dependency. Same concrete class, just a
  // second independent binding of it.
  providers: [InventoryTransactionsService, S3DocumentStorageService],
  exports: [InventoryTransactionsService],
})
export class InventoryTransactionsModule {}
