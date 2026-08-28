import { IsInt, IsPositive, IsString, MinLength } from 'class-validator';

/**
 * No `requestedBy`/identity field here on purpose — the requester is never
 * taken from the client body. StockMovementsController.adjustInventory()
 * derives it from the authenticated JWT user (@CurrentUser()), so it can't
 * be spoofed by sending a fake `role`/`id` in the request.
 */
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
}
