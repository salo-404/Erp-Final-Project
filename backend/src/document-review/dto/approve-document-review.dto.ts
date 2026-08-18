import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDate,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ApproveDocumentReviewItemDto {
  @IsInt()
  @IsPositive()
  productId: number;

  @IsInt()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @Min(0)
  price?: number;
}

/**
 * No `reviewedById` here on purpose — the reviewer is never taken from the
 * client body. DocumentReviewController.approve() derives it from the
 * authenticated JWT user (@CurrentUser()), so it can't be spoofed by
 * sending a fake id in the request.
 */
export class ApproveDocumentReviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApproveDocumentReviewItemDto)
  items: ApproveDocumentReviewItemDto[];

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expectedDate?: Date;

  /** Required when the review's transactionType is INCOMING. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  supplierId?: number;

  /** Required when the review's transactionType is INCOMING. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  destinationWarehouseId?: number;

  /** Required when the review's transactionType is OUTGOING. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  sourceWarehouseId?: number;

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
}
