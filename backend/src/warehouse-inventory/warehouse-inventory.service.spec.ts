import { Test, TestingModule } from '@nestjs/testing';
import { WarehouseInventoryService } from './warehouse-inventory.service';

describe('WarehouseInventoryService', () => {
  let service: WarehouseInventoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WarehouseInventoryService],
    }).compile();

    service = module.get<WarehouseInventoryService>(WarehouseInventoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
