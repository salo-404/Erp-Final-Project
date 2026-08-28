import { Module } from '@nestjs/common';
import { SuppliersModule } from './suppliers.module';
import { SuppliersService } from './suppliers.service';
import { SupplierIntelligenceController } from './supplier-intelligence.controller';
import {
  SUPPLIERS_HISTORY_PROVIDER,
  SupplierIntelligenceService,
} from './supplier-intelligence.service';

@Module({
  imports: [SuppliersModule],
  controllers: [SupplierIntelligenceController],
  providers: [
    SupplierIntelligenceService,
    { provide: SUPPLIERS_HISTORY_PROVIDER, useExisting: SuppliersService },
  ],
  exports: [SupplierIntelligenceService],
})
export class SupplierIntelligenceModule {}
