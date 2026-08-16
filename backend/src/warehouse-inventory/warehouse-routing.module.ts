import { Module } from '@nestjs/common';
import { WarehouseRoutingService } from './warehouse-routing.service';

@Module({
  providers: [WarehouseRoutingService],
  exports: [WarehouseRoutingService],
})
export class WarehouseRoutingModule {}
