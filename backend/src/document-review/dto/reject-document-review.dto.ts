import { IsString, MinLength } from 'class-validator';

/**
 * No `reviewedById` here on purpose — see ApproveDocumentReviewDto's doc
 * comment; the reviewer always comes from the authenticated JWT user.
 */
export class RejectDocumentReviewDto {
  @IsString()
  @MinLength(1)
  rejectionReason: string;
}
