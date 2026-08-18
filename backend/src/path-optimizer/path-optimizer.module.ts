import { Module } from '@nestjs/common';
import { WarehouseRoutingModule } from '../warehouse-inventory/warehouse-routing.module';
import { GeoapifyGeocodingProvider } from './geoapify-geocoding.provider';
import {
  GEOCODING_PROVIDER,
  PathOptimizerService,
} from './path-optimizer.service';

@Module({
  imports: [WarehouseRoutingModule],
  providers: [
    PathOptimizerService,
    { provide: GEOCODING_PROVIDER, useClass: GeoapifyGeocodingProvider },
  ],
  exports: [PathOptimizerService],
})
export class PathOptimizerModule {}
