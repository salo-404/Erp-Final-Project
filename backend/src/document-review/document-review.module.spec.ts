/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DOCUMENT_EXTRACTION_PROVIDER } from './document-review.service';
import { DocumentReviewModule } from './document-review.module';

describe('DocumentReviewModule wiring', () => {
  it('fails to bootstrap without DOCUMENT_EXTRACTION_PROVIDER/DOCUMENT_REVIEW_NOTIFIER bound — confirms this module cannot be imported into AppModule as-is yet, even though DOCUMENT_STORAGE_PROVIDER is now bound to S3DocumentStorageService', async () => {
    await expect(
      Test.createTestingModule({
        imports: [PrismaModule, DocumentReviewModule],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .compile(),
    ).rejects.toThrow(/DOCUMENT_EXTRACTION_PROVIDER/);

    // Confirms the exact symbol name in the error above is the real,
    // exported token — not a coincidental string match.
    expect(DOCUMENT_EXTRACTION_PROVIDER.toString()).toContain(
      'DOCUMENT_EXTRACTION_PROVIDER',
    );
  });
});
