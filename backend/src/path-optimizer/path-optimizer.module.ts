import { Module } from '@nestjs/common';
import { WarehouseRoutingModule } from '../warehouse-inventory/warehouse-routing.module';
import { GeoapifyGeocodingProvider } from './geoapify-geocoding.provider';
import { PathOptimizerController } from './path-optimizer.controller';
import {
  GEOCODING_PROVIDER,
  PathOptimizerService,
} from './path-optimizer.service';

@Module({
  imports: [WarehouseRoutingModule],
  controllers: [PathOptimizerController],
  providers: [
    PathOptimizerService,
    { provide: GEOCODING_PROVIDER, useClass: GeoapifyGeocodingProvider },
  ],
  exports: [PathOptimizerService],
})
export class PathOptimizerModule {}
