/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentReviewService } from './document-review.service';
import { DocumentReviewController } from './document-review.controller';
import { DocumentReviewModule } from './document-review.module';

describe('DocumentReviewModule wiring', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_S3_BUCKET = 'test-bucket';
    process.env.RIBAL_AGENT_URL = 'http://localhost:9000/ribal/extract';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('bootstraps successfully now that all 3 provider tokens (storage, extraction, notifier) are bound — confirms this module is ready to be imported into AppModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, DocumentReviewModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(DocumentReviewService)).toBeInstanceOf(
      DocumentReviewService,
    );
    expect(moduleRef.get(DocumentReviewController)).toBeInstanceOf(
      DocumentReviewController,
    );
  });

  it('fails to bootstrap when RIBAL_AGENT_URL is not configured, since RibalDocumentExtractionProvider requires it', async () => {
    delete process.env.RIBAL_AGENT_URL;

    await expect(
      Test.createTestingModule({
        imports: [PrismaModule, DocumentReviewModule],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .compile(),
    ).rejects.toThrow('RIBAL_AGENT_URL is not configured');
  });
});
