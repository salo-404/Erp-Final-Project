import { Module } from '@nestjs/common';
import { DocumentReviewModule } from '../document-review/document-review.module';
import { InventoryTransactionsModule } from '../inventory-transactions/inventory-transactions.module';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { ControlTowerController } from './control-tower.controller';
import { StockInsightsController } from './stock-insights.controller';
import { StockInsightsService } from './stock-insights.service';

/**
 * NOT imported into AppModule yet — StockInsightsService depends on
 * DocumentReviewService, which imports DocumentReviewModule (see that
 * module's own doc comment: its 3 external-provider tokens aren't bound on
 * this branch). This module inherits that same bootstrap blocker
 * transitively; once DocumentReviewModule's providers are bound, this
 * module — and Control Tower with it — becomes importable as-is.
 */
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
