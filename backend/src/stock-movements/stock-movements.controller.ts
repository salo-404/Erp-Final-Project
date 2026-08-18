import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { StockMovementsService } from './stock-movements.service';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import { StockMovementType } from '../../generated/prisma/enums';

@Controller('stock-movements')
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
   * StockMovementsService.adjustInventory().
   */
  @Post('adjust')
  adjustInventory(@Body() dto: AdjustInventoryDto) {
    return this.stockMovementsService.adjustInventory(dto);
  }
}
