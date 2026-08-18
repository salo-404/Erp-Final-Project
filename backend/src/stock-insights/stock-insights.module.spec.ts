/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StockInsightsService } from './stock-insights.service';
import { StockInsightsController } from './stock-insights.controller';
import { ControlTowerController } from './control-tower.controller';
import { StockInsightsModule } from './stock-insights.module';

describe('StockInsightsModule wiring', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_S3_BUCKET = 'test-bucket';
    process.env.RIBAL_AGENT_URL = 'http://localhost:9000/ribal/extract';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('bootstraps successfully now that DocumentReviewModule (imported transitively via DocumentReviewService) has all 3 provider tokens bound — confirms this module and Control Tower are ready to be wired into AppModule whenever desired', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, StockInsightsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(StockInsightsService)).toBeInstanceOf(
      StockInsightsService,
    );
    expect(moduleRef.get(StockInsightsController)).toBeInstanceOf(
      StockInsightsController,
    );
    expect(moduleRef.get(ControlTowerController)).toBeInstanceOf(
      ControlTowerController,
    );
  });
});
