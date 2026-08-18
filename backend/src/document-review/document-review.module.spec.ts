/// <reference types="jest" />

import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DOCUMENT_STORAGE_PROVIDER } from './document-review.service';
import { DocumentReviewModule } from './document-review.module';

describe('DocumentReviewModule wiring', () => {
  it('fails to bootstrap without its external-provider tokens bound — confirms this module cannot be imported into AppModule as-is yet', async () => {
    await expect(
      Test.createTestingModule({
        imports: [PrismaModule, DocumentReviewModule],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .compile(),
    ).rejects.toThrow(/DOCUMENT_STORAGE_PROVIDER/);

    // Confirms the exact symbol name in the error above is the real,
    // exported token — not a coincidental string match.
    expect(DOCUMENT_STORAGE_PROVIDER.toString()).toContain(
      'DOCUMENT_STORAGE_PROVIDER',
    );
  });
});
