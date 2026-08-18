import { Module } from '@nestjs/common';
import { WarehouseRoutingController } from './warehouse-routing.controller';
import { WarehouseRoutingService } from './warehouse-routing.service';

@Module({
  controllers: [WarehouseRoutingController],
  providers: [WarehouseRoutingService],
  exports: [WarehouseRoutingService],
})
export class WarehouseRoutingModule {}
