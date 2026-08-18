import { Module } from '@nestjs/common';
import { InventoryTransactionsModule } from '../inventory-transactions/inventory-transactions.module';
import { DocumentReviewController } from './document-review.controller';
import { DocumentReviewService } from './document-review.service';

/**
 * NOT imported into AppModule yet — DOCUMENT_STORAGE_PROVIDER,
 * DOCUMENT_EXTRACTION_PROVIDER, and DOCUMENT_REVIEW_NOTIFIER have no
 * bindings here. No S3 client, AI/document-extraction backend, or
 * notification integration has been chosen or implemented yet (see prior
 * Document Review phase reports) — inventing one would mean guessing a
 * vendor and credentials that don't exist. Nest would fail to bootstrap the
 * app if this module were imported without those three bindings.
 *
 * To wire this up for real: implement concrete classes for the three
 * provider interfaces (GeoapifyGeocodingProvider in path-optimizer/ is the
 * template for "real external API, bound via DI token, never hard-coded
 * credentials") and add them here as
 * `{ provide: DOCUMENT_STORAGE_PROVIDER, useClass: ... }` etc. Everything
 * else — DocumentReviewService and its controller — is otherwise complete
 * and already tested.
 */
@Module({
  imports: [InventoryTransactionsModule],
  controllers: [DocumentReviewController],
  providers: [DocumentReviewService],
  exports: [DocumentReviewService],
})
export class DocumentReviewModule {}
