import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsPositive,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { UserRole } from '../../../generated/prisma/enums';

/**
 * No auth guard is wired on this route yet (none exist anywhere in this app
 * except one auth.controller.ts route) — until JwtAuthGuard/RolesGuard are
 * rolled out project-wide, the caller identity is passed explicitly, the
 * same way DocumentReviewService already takes `reviewedById` in its DTOs.
 * StockMovementsService.adjustInventory() is still the authoritative
 * ADMIN-only check; this is just how that identity reaches it for now.
 */
export class AdjustInventoryRequestedByDto {
  @IsInt()
  id: number;

  @IsEnum(UserRole)
  role: UserRole;
}

export class AdjustInventoryDto {
  @IsInt()
  @IsPositive()
  productId: number;

  @IsInt()
  @IsPositive()
  warehouseId: number;

  /** Signed delta — positive increases onHand, negative decreases it. Non-zero is enforced by StockMovementsService. */
  @IsInt()
  quantity: number;

  @IsString()
  @MinLength(1)
  reason: string;

  @ValidateNested()
  @Type(() => AdjustInventoryRequestedByDto)
  requestedBy: AdjustInventoryRequestedByDto;
}
