import { Test, TestingModule } from '@nestjs/testing';
import { WarehouseInventoryController } from './warehouse-inventory.controller';
import { WarehouseInventoryService } from './warehouse-inventory.service';

describe('WarehouseInventoryController', () => {
  let controller: WarehouseInventoryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WarehouseInventoryController],
      providers: [{ provide: WarehouseInventoryService, useValue: {} }],
    }).compile();

    controller = module.get<WarehouseInventoryController>(
      WarehouseInventoryController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
