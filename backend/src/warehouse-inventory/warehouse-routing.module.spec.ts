/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WarehouseRoutingModule } from './warehouse-routing.module';
import { WarehouseRoutingService } from './warehouse-routing.service';

describe('WarehouseRoutingModule wiring', () => {
  it('provides WarehouseRoutingService through NestJS dependency injection', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, WarehouseRoutingModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    const service = moduleRef.get(WarehouseRoutingService);

    expect(service).toBeInstanceOf(WarehouseRoutingService);
  });
});
