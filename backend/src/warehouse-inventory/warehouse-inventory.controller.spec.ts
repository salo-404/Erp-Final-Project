import { Test, TestingModule } from '@nestjs/testing';
import { WarehouseInventoryController } from './warehouse-inventory.controller';

describe('WarehouseInventoryController', () => {
  let controller: WarehouseInventoryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WarehouseInventoryController],
    }).compile();

    controller = module.get<WarehouseInventoryController>(WarehouseInventoryController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
