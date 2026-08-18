import { IsInt, IsPositive, IsString, MinLength } from 'class-validator';

export class RejectDocumentReviewDto {
  @IsInt()
  @IsPositive()
  reviewedById: number;

  @IsString()
  @MinLength(1)
  rejectionReason: string;
}
