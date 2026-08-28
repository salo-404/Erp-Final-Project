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

export class CreateOutgoingDto {
  @IsInt()
  @IsPositive()
  sourceWarehouseId: number;

  @IsOptional()
  @IsString()
  partyName?: string;

  @IsOptional()
  @IsString()
  deliveryCountry?: string;

  @IsOptional()
  @IsString()
  deliveryRegion?: string;

  @IsOptional()
  @IsString()
  deliveryAddress?: string;

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
