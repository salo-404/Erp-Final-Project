/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DocumentReviewService } from './document-review.service';
import { DocumentReviewController } from './document-review.controller';
import { DocumentReviewModule } from './document-review.module';
import { DOCUMENT_EXTRACTION_PROVIDER } from './document-review.service';
import { TextractDocumentExtractionProvider } from './textract-document-extraction.provider';

describe('DocumentReviewModule wiring', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_S3_BUCKET = 'test-bucket';
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
    expect(moduleRef.get(DOCUMENT_EXTRACTION_PROVIDER)).toBeInstanceOf(
      TextractDocumentExtractionProvider,
    );
  });

  it.each(['AWS_REGION', 'AWS_S3_BUCKET'] as const)(
    'fails to bootstrap when %s is not configured',
    async (variable) => {
      delete process.env[variable];

      await expect(
        Test.createTestingModule({
          imports: [PrismaModule, DocumentReviewModule],
        })
          .overrideProvider(PrismaService)
          .useValue({})
          .compile(),
      ).rejects.toThrow(`${variable} is not configured`);
    },
  );
});
