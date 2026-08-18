import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SupplierIntelligenceService } from './supplier-intelligence.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

/**
 * Separate from Joseph's SuppliersController on purpose (per the
 * architecture rules: SupplierService and SupplierIntelligenceService stay
 * separate) — his controller file isn't present on this branch to extend.
 * Path chosen not to collide with `/suppliers` so this can be folded into
 * it at merge time without a rewrite.
 */
@Controller('supplier-intelligence')
@UseGuards(JwtAuthGuard)
export class SupplierIntelligenceController {
  constructor(
    private readonly supplierIntelligenceService: SupplierIntelligenceService,
  ) {}

  @Get(':supplierId/stats')
  getSupplierStats(@Param('supplierId', ParseIntPipe) supplierId: number) {
    return this.supplierIntelligenceService.getSupplierStats(supplierId);
  }

  @Get('compare')
  compareSuppliers(@Query('productId', ParseIntPipe) productId: number) {
    return this.supplierIntelligenceService.compareSuppliers(productId);
  }

  @Get('rank')
  rankSuppliers(@Query('productId', ParseIntPipe) productId: number) {
    return this.supplierIntelligenceService.rankSuppliers(productId);
  }

  @Get('best')
  getBestSupplier(@Query('productId', ParseIntPipe) productId: number) {
    return this.supplierIntelligenceService.getBestSupplier(productId);
  }
}
