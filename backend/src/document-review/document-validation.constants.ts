// Shared by DocumentReviewService and InventoryTransactionsService's
// attachDocument() — kept dependency-free (no imports from either service)
// so both can import it without creating a circular module dependency.

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
] as const;

export type AllowedDocumentMimeType =
  (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

/**
 * Not specified anywhere in the schema/docs — a reasonable, explicit default
 * for an invoice/document scan. Callers needing a different limit should
 * override at the controller/integration layer rather than this being
 * silently hard-coded deeper than here.
 */
export const MAX_DOCUMENT_SIZE_BYTES = 15 * 1024 * 1024;
