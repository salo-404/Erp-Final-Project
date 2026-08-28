/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryTransactionsModule } from './inventory-transactions.module';
import { InventoryTransactionsService } from './inventory-transactions.service';
import { InventoryTransactionsController } from './inventory-transactions.controller';

describe('InventoryTransactionsModule wiring', () => {
  // S3DocumentStorageService (now provided by this module for
  // attachDocument()) throws at construction if these aren't set — same
  // pattern as document-review.module.spec.ts.
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_S3_BUCKET = 'test-bucket';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('provides InventoryTransactionsService and its controller through real NestJS dependency injection (proves it is genuinely importable into AppModule as-is)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, InventoryTransactionsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    const service = moduleRef.get(InventoryTransactionsService);
    const controller = moduleRef.get(InventoryTransactionsController);

    expect(service).toBeInstanceOf(InventoryTransactionsService);
    expect(controller).toBeInstanceOf(InventoryTransactionsController);
  });
});
