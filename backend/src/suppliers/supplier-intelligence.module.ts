import { Module } from '@nestjs/common';
import { SupplierIntelligenceController } from './supplier-intelligence.controller';
import { SupplierIntelligenceService } from './supplier-intelligence.service';

/**
 * NOT imported into AppModule yet — SUPPLIERS_HISTORY_PROVIDER has no
 * binding on this branch (Joseph's SuppliersService, the only thing that
 * satisfies the SuppliersHistoryProvider contract, isn't present here).
 * Nest would fail to bootstrap the app if this module were imported without
 * that binding. At merge time, import this module alongside Joseph's
 * SuppliersModule and add:
 *
 *   { provide: SUPPLIERS_HISTORY_PROVIDER, useExisting: SuppliersService }
 *
 * to this module's (or the composing module's) providers array — no other
 * change needed; SupplierIntelligenceService and its controller are
 * otherwise complete and already tested.
 */
@Module({
  controllers: [SupplierIntelligenceController],
  providers: [SupplierIntelligenceService],
  exports: [SupplierIntelligenceService],
})
export class SupplierIntelligenceModule {}
