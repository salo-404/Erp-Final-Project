import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDate,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { TransactionItemDto } from './transaction-item.dto';

export class CreateIncomingDto {
  @IsInt()
  @IsPositive()
  supplierId: number;

  @IsInt()
  @IsPositive()
  destinationWarehouseId: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expectedDate?: Date;

  @IsOptional()
  @IsString()
  documentUrl?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransactionItemDto)
  items: TransactionItemDto[];
}
