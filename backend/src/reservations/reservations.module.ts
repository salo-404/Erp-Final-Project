import { Module } from '@nestjs/common';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [StockMovementsModule],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
