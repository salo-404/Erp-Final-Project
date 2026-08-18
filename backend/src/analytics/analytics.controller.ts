import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // 1. Top-selling products
  @Get('top-selling-products')
  getTopSellingProducts(
    @Query('warehouseId', new ParseIntPipe({ optional: true }))
    warehouseId?: number,
  ) {
    return this.analyticsService.getTopSellingProducts(warehouseId);
  }

  // 2. Lowest-selling products
  @Get('lowest-selling-products')
  getLowestSellingProducts(
    @Query('warehouseId', new ParseIntPipe({ optional: true }))
    warehouseId?: number,
  ) {
    return this.analyticsService.getLowestSellingProducts(warehouseId);
  }

  // 3. Fast-moving products
  @Get('fast-moving-products')
  getFastMovingProducts(
    @Query('days') days?: string,
    @Query('warehouseId', new ParseIntPipe({ optional: true }))
    warehouseId?: number,
  ) {
    return this.analyticsService.getFastMovingProducts(
      days ? Number(days) : 30,
      warehouseId,
    );
  }

  // 4. Slow-moving products
  @Get('slow-moving-products')
  getSlowMovingProducts(
    @Query('days') days?: string,
    @Query('warehouseId', new ParseIntPipe({ optional: true }))
    warehouseId?: number,
  ) {
    return this.analyticsService.getSlowMovingProducts(
      days ? Number(days) : 30,
      warehouseId,
    );
  }

  // 5. Sales trends
  @Get('sales-trends')
  getSalesTrends() {
    return this.analyticsService.getSalesTrends();
  }

  // 6. Purchase trends
  @Get('purchase-trends')
  getPurchaseTrends() {
    return this.analyticsService.getPurchaseTrends();
  }

  // 7. Stock history for a product
  @Get('stock-history/:productId')
  getStockHistory(
    @Param('productId', ParseIntPipe) productId: number,
    @Query('warehouseId') warehouseId?: string,
  ) {
    return this.analyticsService.getStockHistory(
      productId,
      warehouseId ? Number(warehouseId) : undefined,
    );
  }

  // 8. Warehouse demand
  @Get('warehouse-demand')
  getWarehouseDemand(
    @Query('warehouseId', new ParseIntPipe({ optional: true }))
    warehouseId?: number,
  ) {
    return this.analyticsService.getWarehouseDemand(warehouseId);
  }

  // 9. Demand for one product
  @Get('product-demand/:productId')
  getProductDemand(@Param('productId', ParseIntPipe) productId: number) {
    return this.analyticsService.getProductDemand(productId);
  }

  // 10. Supplier comparison
  @Get('supplier-comparison')
  getSupplierComparison() {
    return this.analyticsService.getSupplierComparison();
  }
}
