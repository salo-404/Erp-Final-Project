import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

export class FindNearestWarehouseDto {
  @IsInt()
  @IsPositive()
  productId: number;

  @IsInt()
  @IsPositive()
  requiredQuantity: number;

  @IsOptional()
  @IsString()
  deliveryCountry?: string;

  @IsOptional()
  @IsString()
  deliveryRegion?: string;

  @IsOptional()
  @IsString()
  deliveryAddress?: string;

  /** Set only for an internal replenishment lookup, where the "destination" is itself a warehouse — see PathOptimizerService.findNearestWarehouse(). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  destinationWarehouseId?: number;
}
