/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryTransactionsModule } from './inventory-transactions.module';
import { InventoryTransactionsService } from './inventory-transactions.service';
import { InventoryTransactionsController } from './inventory-transactions.controller';

describe('InventoryTransactionsModule wiring', () => {
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
