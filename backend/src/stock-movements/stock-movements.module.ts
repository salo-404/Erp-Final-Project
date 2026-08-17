import { Module } from '@nestjs/common';
import { StockMovementsService } from './stock-movements.service';

@Module({
  providers: [StockMovementsService],
  exports: [StockMovementsService],
})
export class StockMovementsModule {}
