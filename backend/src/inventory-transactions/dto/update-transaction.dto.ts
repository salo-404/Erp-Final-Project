import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDate,
  IsInt,
  IsOptional,
  IsPositive,
  Min,
  ValidateNested,
} from 'class-validator';

export class UpdateTransactionItemChangeDto {
  @IsInt()
  @IsPositive()
  itemId: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  productId?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  quantity?: number;

  @IsOptional()
  @Min(0)
  price?: number;
}

export class UpdateTransactionDto {
  /** OUTGOING/TRANSFER only — changing this resynchronizes every item's reservation (see InventoryTransactionsService.update()). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  sourceWarehouseId?: number;

  /** INCOMING/TRANSFER only. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  destinationWarehouseId?: number;

  /** INCOMING only. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  supplierId?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expectedDate?: Date;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpdateTransactionItemChangeDto)
  items?: UpdateTransactionItemChangeDto[];
}
