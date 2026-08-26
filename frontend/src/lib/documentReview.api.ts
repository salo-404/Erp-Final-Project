import { apiRequest, ApiError, getStoredToken } from "./api-client";
import { API_URL } from "./env";
import type {
  ApproveDocumentReviewInput,
  DocumentMatchResult,
  PendingDocumentReview,
  PendingDocumentReviewWithDetails,
} from "../types/domain";

// Multipart — see attachTransactionDocument() in inventoryTransactions.api.ts
// for why this bypasses apiRequest()'s JSON Content-Type.
export async function uploadDocument(file: File): Promise<PendingDocumentReview> {
  const formData = new FormData();
  formData.append("file", file);

  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${API_URL}/document-review/upload`, {
    method: "POST",
    headers,
    body: formData,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload ?? { statusCode: response.status, message: response.statusText, error: "Error" }, response.status);
  }
  return payload as PendingDocumentReview;
}

export function listPendingReviews(): Promise<PendingDocumentReview[]> {
  return apiRequest<PendingDocumentReview[]>("/document-review/pending");
}

export function getReview(id: number): Promise<PendingDocumentReviewWithDetails> {
  return apiRequest<PendingDocumentReviewWithDetails>(`/document-review/${id}`);
}

export function getReviewPresignedUrl(id: number): Promise<{ url: string }> {
  return apiRequest<{ url: string }>(`/document-review/${id}/presigned-url`);
}

// Backed by the real Document agent LLM (a genuine reasoning call, not an
// instant lookup) with an automatic fuzzy-matcher fallback on the backend
// if that call fails or times out — see DocumentReviewService.resolveProduct()/
// resolveSupplier(). Always returns the full result (status, up to 3 real
// candidates with confidence/reason, and — for a NO_MATCH product — a
// recommendation) rather than a bare name/score list.
export function resolveProduct(query: string): Promise<DocumentMatchResult> {
  return apiRequest<DocumentMatchResult>(`/document-review/resolve-product?query=${encodeURIComponent(query)}`);
}

export function resolveSupplier(query: string): Promise<DocumentMatchResult> {
  return apiRequest<DocumentMatchResult>(`/document-review/resolve-supplier?query=${encodeURIComponent(query)}`);
}

export function approveReview(id: number, input: ApproveDocumentReviewInput): Promise<PendingDocumentReview> {
  return apiRequest<PendingDocumentReview>(`/document-review/${id}/approve`, { method: "POST", body: input });
}

export function rejectReview(id: number, rejectionReason: string): Promise<PendingDocumentReview> {
  return apiRequest<PendingDocumentReview>(`/document-review/${id}/reject`, {
    method: "POST",
    body: { rejectionReason },
  });
}
