import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsPositive,
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
}

export class UpdateTransactionDto {
  /** OUTGOING/TRANSFER only — changing this resynchronizes every item's reservation (see InventoryTransactionsService.update()). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  sourceWarehouseId?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpdateTransactionItemChangeDto)
  items?: UpdateTransactionItemChangeDto[];
}
