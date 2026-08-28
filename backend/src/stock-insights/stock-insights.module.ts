import { Module } from '@nestjs/common';
import { DocumentReviewModule } from '../document-review/document-review.module';
import { InventoryTransactionsModule } from '../inventory-transactions/inventory-transactions.module';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { ControlTowerController } from './control-tower.controller';
import { StockInsightsController } from './stock-insights.controller';
import { StockInsightsService } from './stock-insights.service';

@Module({
  imports: [
    StockMovementsModule,
    InventoryTransactionsModule,
    DocumentReviewModule,
  ],
  controllers: [StockInsightsController, ControlTowerController],
  providers: [StockInsightsService],
  exports: [StockInsightsService],
})
export class StockInsightsModule {}
