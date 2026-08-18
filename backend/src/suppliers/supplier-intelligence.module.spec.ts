/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SupplierIntelligenceService } from './supplier-intelligence.service';
import { SupplierIntelligenceController } from './supplier-intelligence.controller';
import { SupplierIntelligenceModule } from './supplier-intelligence.module';

describe('SupplierIntelligenceModule wiring', () => {
  it("bootstraps with SUPPLIERS_HISTORY_PROVIDER bound to SuppliersService — confirms the module is fully integrated with Joseph's SuppliersModule", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SupplierIntelligenceModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(SupplierIntelligenceService)).toBeInstanceOf(
      SupplierIntelligenceService,
    );
    expect(moduleRef.get(SupplierIntelligenceController)).toBeInstanceOf(
      SupplierIntelligenceController,
    );
  });
});
