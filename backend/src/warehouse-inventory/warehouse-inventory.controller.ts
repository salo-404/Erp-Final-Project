import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
} from '@nestjs/common';
import { WarehouseInventoryService } from './warehouse-inventory.service';
import { UpdateReorderThresholdDto } from './dto/update-reorder-threshold.dto';

@Controller('warehouse-inventory')
export class WarehouseInventoryController {
  constructor(
    private readonly warehouseInventoryService: WarehouseInventoryService,
  ) {}

  @Get('warehouse/:warehouseId')
  getByWarehouse(@Param('warehouseId', ParseIntPipe) warehouseId: number) {
    return this.warehouseInventoryService.getByWarehouse(warehouseId);
  }

  @Get('product/:productId')
  getByProduct(@Param('productId', ParseIntPipe) productId: number) {
    return this.warehouseInventoryService.getByProduct(productId);
  }

  @Get('available/:warehouseId/:productId')
  getAvailable(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Param('productId', ParseIntPipe) productId: number,
  ) {
    return this.warehouseInventoryService.getAvailable(warehouseId, productId);
  }

  @Get('low-stock/:warehouseId')
  getLowStockProducts(@Param('warehouseId', ParseIntPipe) warehouseId: number) {
    return this.warehouseInventoryService.getLowStockProducts(warehouseId);
  }

  @Get('capacity/:warehouseId')
  getWarehouseCapacity(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
  ) {
    return this.warehouseInventoryService.getWarehouseCapacity(warehouseId);
  }

  @Patch(':warehouseId/:productId/reorder-threshold')
  setReorderThreshold(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: UpdateReorderThresholdDto,
  ) {
    return this.warehouseInventoryService.setReorderThreshold(
      warehouseId,
      productId,
      dto,
    );
  }
}
