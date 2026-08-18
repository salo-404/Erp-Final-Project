import {
  Controller,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { StockInsightsService } from './stock-insights.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('stock-insights')
@UseGuards(JwtAuthGuard)
export class StockInsightsController {
  constructor(private readonly stockInsightsService: StockInsightsService) {}

  @Get('dead-stock')
  getDeadStock(
    @Query('inactivityDays', new ParseIntPipe({ optional: true }))
    inactivityDays?: number,
    @Query('referenceDate') referenceDate?: string,
  ) {
    return this.stockInsightsService.getDeadStock(
      inactivityDays,
      referenceDate ? new Date(referenceDate) : undefined,
    );
  }

  @Get('consumption-anomalies')
  getConsumptionAnomalies(
    @Query('windowDays', new ParseIntPipe({ optional: true }))
    windowDays?: number,
    @Query('thresholdPercent', new ParseIntPipe({ optional: true }))
    thresholdPercent?: number,
    @Query('referenceDate') referenceDate?: string,
    @Query('minimumQuantityChange', new ParseIntPipe({ optional: true }))
    minimumQuantityChange?: number,
  ) {
    return this.stockInsightsService.getConsumptionAnomalies(
      windowDays,
      thresholdPercent,
      referenceDate ? new Date(referenceDate) : undefined,
      minimumQuantityChange,
    );
  }

  @Get('stockout-risk')
  getStockoutRisk(
    @Query('consumptionWindowDays', new ParseIntPipe({ optional: true }))
    consumptionWindowDays?: number,
    @Query('referenceDate') referenceDate?: string,
  ) {
    return this.stockInsightsService.getStockoutRisk(
      consumptionWindowDays,
      referenceDate ? new Date(referenceDate) : undefined,
    );
  }

  @Get('restock-recommendations')
  getRestockRecommendations(
    @Query('consumptionWindowDays', new ParseIntPipe({ optional: true }))
    consumptionWindowDays?: number,
    @Query('referenceDate') referenceDate?: string,
  ) {
    return this.stockInsightsService.getRestockRecommendations(
      consumptionWindowDays,
      referenceDate ? new Date(referenceDate) : undefined,
    );
  }

  @Get('transfer-recommendations')
  getTransferRecommendations(
    @Query('consumptionWindowDays', new ParseIntPipe({ optional: true }))
    consumptionWindowDays?: number,
    @Query('referenceDate') referenceDate?: string,
  ) {
    return this.stockInsightsService.getTransferRecommendations(
      consumptionWindowDays,
      referenceDate ? new Date(referenceDate) : undefined,
    );
  }
}
