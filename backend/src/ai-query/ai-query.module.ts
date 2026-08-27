import { Module } from '@nestjs/common';
import { AiQueryController } from './ai-query.controller';
import { AiQueryService } from './ai-query.service';

@Module({
  controllers: [AiQueryController],
  providers: [AiQueryService],
})
export class AiQueryModule {}
