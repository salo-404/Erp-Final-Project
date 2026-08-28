import {
  Controller,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { StockInsightsService } from './stock-insights.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

/**
 * Control Tower is the aggregation/presentation layer over Stock Insights +
 * Inventory Transactions + Document Review — kept as its own controller
 * (per the architecture split) even though it's backed by the same
 * StockInsightsService as StockInsightsController; getControlTowerAlerts()
 * itself does all the aggregation, nothing is duplicated here.
 */
@Controller('control-tower')
@UseGuards(JwtAuthGuard)
export class ControlTowerController {
  constructor(private readonly stockInsightsService: StockInsightsService) {}

  @Get('alerts')
  getControlTowerAlerts(
    @Query('deadStockInactivityDays', new ParseIntPipe({ optional: true }))
    deadStockInactivityDays?: number,
    @Query('consumptionWindowDays', new ParseIntPipe({ optional: true }))
    consumptionWindowDays?: number,
    @Query('consumptionThresholdPercent', new ParseIntPipe({ optional: true }))
    consumptionThresholdPercent?: number,
    @Query('referenceDate') referenceDate?: string,
  ) {
    return this.stockInsightsService.getControlTowerAlerts(
      {
        deadStockInactivityDays,
        consumptionWindowDays,
        consumptionThresholdPercent,
      },
      referenceDate ? new Date(referenceDate) : undefined,
    );
  }
}
