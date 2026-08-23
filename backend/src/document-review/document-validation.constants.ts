// Shared by DocumentReviewService and InventoryTransactionsService's
// attachDocument() — kept dependency-free (no imports from either service)
// so both can import it without creating a circular module dependency.
//
// Values match AWS Textract's synchronous AnalyzeExpense limits: single-page
// PDF, JPEG, and PNG only (no Word docs), capped at 10 MB.

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

export type AllowedDocumentMimeType =
  (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
