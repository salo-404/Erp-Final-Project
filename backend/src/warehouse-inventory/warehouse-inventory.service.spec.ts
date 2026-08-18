import { Test, TestingModule } from '@nestjs/testing';
import { WarehouseInventoryService } from './warehouse-inventory.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WarehouseInventoryService', () => {
  let service: WarehouseInventoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarehouseInventoryService,
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    service = module.get<WarehouseInventoryService>(WarehouseInventoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
