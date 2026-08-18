import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { InventoryTransactionsController } from './inventory-transactions.controller';
import { InventoryTransactionsService } from './inventory-transactions.service';

@Module({
  imports: [ReservationsModule, StockMovementsModule],
  controllers: [InventoryTransactionsController],
  providers: [InventoryTransactionsService],
  exports: [InventoryTransactionsService],
})
export class InventoryTransactionsModule {}
