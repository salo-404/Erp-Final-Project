import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { StockMovementsService } from './stock-movements.service';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import { StockMovementType } from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/enums';

@Controller('stock-movements')
@UseGuards(JwtAuthGuard)
export class StockMovementsController {
  constructor(private readonly stockMovementsService: StockMovementsService) {}

  /**
   * Read-only ledger query. Raw `@Query()` + pipes, no DTO — matches the
   * convention Joseph's AnalyticsController already uses for GET filters.
   */
  @Get('ledger')
  getLedger(
    @Query('productId', new ParseIntPipe({ optional: true }))
    productId?: number,
    @Query('warehouseId', new ParseIntPipe({ optional: true }))
    warehouseId?: number,
    @Query('transactionId', new ParseIntPipe({ optional: true }))
    transactionId?: number,
    @Query('type') type?: StockMovementType,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.stockMovementsService.getLedger({
      productId,
      warehouseId,
      transactionId,
      type,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
    });
  }

  /**
   * Read-only reconciliation report — never fixes anything (see
   * StockMovementsService.reconcileInventory()'s own doc comment).
   */
  @Get('reconcile')
  reconcileInventory() {
    return this.stockMovementsService.reconcileInventory();
  }

  /**
   * Admin-only manual correction, routed entirely through the existing
   * recordMovement() as an ADJUSTMENT movement — see
   * StockMovementsService.adjustInventory(). `requestedBy` comes from the
   * authenticated JWT user, never the request body — a client cannot claim
   * a different id or role to get past the ADMIN check.
   */
  @Post('adjust')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  adjustInventory(
    @Body() dto: AdjustInventoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.stockMovementsService.adjustInventory({
      ...dto,
      requestedBy: { id: user.id, role: user.role },
    });
  }
}
