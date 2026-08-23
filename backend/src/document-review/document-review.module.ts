import { Module } from '@nestjs/common';
import { EmailModule } from '../integrations/email/email.module';
import { InventoryTransactionsModule } from '../inventory-transactions/inventory-transactions.module';
import { DocumentReviewController } from './document-review.controller';
import {
  DOCUMENT_EXTRACTION_PROVIDER,
  DOCUMENT_REVIEW_NOTIFIER,
  DOCUMENT_STORAGE_PROVIDER,
  DocumentReviewService,
} from './document-review.service';
import { EmailDocumentReviewNotifier } from './email-document-review.notifier';
import { TextractDocumentExtractionProvider } from './textract-document-extraction.provider';
import { S3DocumentStorageService } from './s3-document-storage.service';

/**
 * All three provider tokens are now bound:
 *   - DOCUMENT_STORAGE_PROVIDER    -> S3DocumentStorageService
 *   - DOCUMENT_EXTRACTION_PROVIDER -> TextractDocumentExtractionProvider
 *     (AnalyzeExpense reads the already-private S3 object directly)
 *   - DOCUMENT_REVIEW_NOTIFIER     -> EmailDocumentReviewNotifier (reuses
 *     Joseph's EmailModule/EmailService)
 * This module can now be imported into AppModule.
 */
@Module({
  imports: [InventoryTransactionsModule, EmailModule],
  controllers: [DocumentReviewController],
  providers: [
    DocumentReviewService,
    {
      provide: DOCUMENT_STORAGE_PROVIDER,
      useClass: S3DocumentStorageService,
    },
    {
      provide: DOCUMENT_EXTRACTION_PROVIDER,
      useClass: TextractDocumentExtractionProvider,
    },
    {
      provide: DOCUMENT_REVIEW_NOTIFIER,
      useClass: EmailDocumentReviewNotifier,
    },
  ],
  exports: [DocumentReviewService],
})
export class DocumentReviewModule {}
