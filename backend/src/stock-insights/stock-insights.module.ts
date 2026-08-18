import { Module } from '@nestjs/common';
import { DocumentReviewModule } from '../document-review/document-review.module';
import { InventoryTransactionsModule } from '../inventory-transactions/inventory-transactions.module';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { ControlTowerController } from './control-tower.controller';
import { StockInsightsController } from './stock-insights.controller';
import { StockInsightsService } from './stock-insights.service';

/**
 * NOT imported into AppModule yet — not because of a bootstrap blocker
 * (DocumentReviewModule, which this module imports transitively via
 * StockInsightsService's dependency on DocumentReviewService, now has all
 * 3 provider tokens bound and bootstraps fine on its own). Wiring this
 * module — and Control Tower with it — into AppModule simply wasn't part
 * of the phase that bound those tokens; it's a one-line addition whenever
 * that's wanted.
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
