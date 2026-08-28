import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDate,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A brand-new product to create atomically with approval — see
 * ApproveDocumentReviewItemInput's own docstring in document-review.service.ts.
 * Only structural validation here; DocumentReviewService.resolveApprovalItems()
 * is what actually enforces the transactionType restriction, the exact-
 * duplicate check, and that a line has exactly one resolution path.
 */
export class NewProductDefinitionDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  category?: string;
}

export class ApproveDocumentReviewItemDto {
  /**
   * Set when this line resolves to an existing product. Mutually exclusive
   * with newProduct — a line must supply exactly one; the service layer
   * rejects both missing or both present.
   */
  @IsOptional()
  @IsInt()
  @IsPositive()
  productId?: number;

  /** Set instead of productId for a brand-new INCOMING product — see NewProductDefinitionDto. */
  @IsOptional()
  @ValidateNested()
  @Type(() => NewProductDefinitionDto)
  newProduct?: NewProductDefinitionDto;

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
