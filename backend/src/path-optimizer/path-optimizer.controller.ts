import { Body, Controller, Post } from '@nestjs/common';
import { PathOptimizerService } from './path-optimizer.service';
import { FindNearestWarehouseDto } from './dto/find-nearest-warehouse.dto';

@Controller('path-optimizer')
export class PathOptimizerController {
  constructor(private readonly pathOptimizerService: PathOptimizerService) {}

  @Post('nearest-warehouse')
  findNearestWarehouse(@Body() dto: FindNearestWarehouseDto) {
    return this.pathOptimizerService.findNearestWarehouse(dto);
  }
}
