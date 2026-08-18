import { Body, Controller, Post } from '@nestjs/common';
import { WarehouseRoutingService } from './warehouse-routing.service';
import { FindEligibleWarehousesDto } from './dto/find-eligible-warehouses.dto';

/**
 * Separate from Joseph's WarehouseInventoryController/WarehousesController
 * on purpose — WarehouseRoutingService is explicitly its own responsibility
 * (per the architecture rules: WarehouseService and WarehouseRoutingService
 * stay separate), and his controller files aren't present on this branch to
 * extend. Path chosen not to collide with `/warehouses` or
 * `/warehouse-inventory` so this can be folded into either at merge time
 * without a rewrite.
 */
@Controller('warehouse-routing')
export class WarehouseRoutingController {
  constructor(
    private readonly warehouseRoutingService: WarehouseRoutingService,
  ) {}

  @Post('eligible-warehouses')
  findEligibleWarehousesForOrder(@Body() dto: FindEligibleWarehousesDto) {
    return this.warehouseRoutingService.findEligibleWarehousesForOrder(
      dto.deliveryCountry,
      dto.deliveryRegion,
      dto.items,
    );
  }
}
