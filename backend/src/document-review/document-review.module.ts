import { Module } from '@nestjs/common';
import { InventoryTransactionsModule } from '../inventory-transactions/inventory-transactions.module';
import { DocumentReviewController } from './document-review.controller';
import {
  DOCUMENT_STORAGE_PROVIDER,
  DocumentReviewService,
} from './document-review.service';
import { S3DocumentStorageService } from './s3-document-storage.service';

/**
 * NOT imported into AppModule yet — DOCUMENT_STORAGE_PROVIDER is now bound
 * to the real S3DocumentStorageService (see that file), but
 * DOCUMENT_EXTRACTION_PROVIDER and DOCUMENT_REVIEW_NOTIFIER still have no
 * bindings. No AI/document-extraction backend or notification integration
 * has been chosen or implemented yet — inventing one would mean guessing a
 * vendor and credentials that don't exist. Nest would fail to bootstrap the
 * app if this module were imported without those two bindings.
 *
 * To finish wiring this up: implement concrete classes for the remaining
 * two provider interfaces (GeoapifyGeocodingProvider in path-optimizer/,
 * and now S3DocumentStorageService here, are the template — "real external
 * API/SDK, bound via DI token, never hard-coded credentials") and add them
 * here as `{ provide: DOCUMENT_EXTRACTION_PROVIDER, useClass: ... }` etc.
 * Everything else — DocumentReviewService and its controller — is otherwise
 * complete and already tested.
 */
@Module({
  imports: [InventoryTransactionsModule],
  controllers: [DocumentReviewController],
  providers: [
    DocumentReviewService,
    {
      provide: DOCUMENT_STORAGE_PROVIDER,
      useClass: S3DocumentStorageService,
    },
  ],
  exports: [DocumentReviewService],
})
export class DocumentReviewModule {}
