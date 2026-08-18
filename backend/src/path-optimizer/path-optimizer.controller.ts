import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { PathOptimizerService } from './path-optimizer.service';
import { FindNearestWarehouseDto } from './dto/find-nearest-warehouse.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('path-optimizer')
@UseGuards(JwtAuthGuard)
export class PathOptimizerController {
  constructor(private readonly pathOptimizerService: PathOptimizerService) {}

  @Post('nearest-warehouse')
  findNearestWarehouse(@Body() dto: FindNearestWarehouseDto) {
    return this.pathOptimizerService.findNearestWarehouse(dto);
  }
}
