/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DOCUMENT_STORAGE_PROVIDER } from '../document-review/document-review.service';
import { StockInsightsModule } from './stock-insights.module';

describe('StockInsightsModule wiring', () => {
  it("fails to bootstrap because it transitively depends on DocumentReviewModule's unbound provider tokens — confirms this module (and Control Tower with it) cannot be imported into AppModule as-is yet", async () => {
    await expect(
      Test.createTestingModule({
        imports: [PrismaModule, StockInsightsModule],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .compile(),
    ).rejects.toThrow(/DOCUMENT_STORAGE_PROVIDER/);

    expect(DOCUMENT_STORAGE_PROVIDER.toString()).toContain(
      'DOCUMENT_STORAGE_PROVIDER',
    );
  });
});
