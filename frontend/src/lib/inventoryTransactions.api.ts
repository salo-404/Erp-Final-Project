import { apiRequest } from "./api-client";
import { API_URL } from "./env";
import { ApiError, getStoredToken } from "./api-client";
import type {
  CreateIncomingInput,
  CreateOutgoingInput,
  CreateTransferInput,
  InventoryTransactionStatus,
  InventoryTransactionSummary,
  InventoryTransactionType,
  InventoryTransactionWithItems,
} from "../types/domain";

export interface TransactionListFilters {
  type?: InventoryTransactionType;
  status?: InventoryTransactionStatus;
  sourceWarehouseId?: number;
  destinationWarehouseId?: number;
}

export function listTransactions(filters: TransactionListFilters): Promise<InventoryTransactionWithItems[]> {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.status) params.set("status", filters.status);
  if (filters.sourceWarehouseId !== undefined) params.set("sourceWarehouseId", String(filters.sourceWarehouseId));
  if (filters.destinationWarehouseId !== undefined) {
    params.set("destinationWarehouseId", String(filters.destinationWarehouseId));
  }
  const qs = params.toString();
  return apiRequest<InventoryTransactionWithItems[]>(`/inventory-transactions${qs ? `?${qs}` : ""}`);
}

// Used only to resolve the transfer counterpart warehouse for the Warehouses
// page's Movement Ledger "Related" column — no other fields are needed here.
export function listTransfers(): Promise<InventoryTransactionSummary[]> {
  return apiRequest<InventoryTransactionSummary[]>("/inventory-transactions?type=TRANSFER");
}

export function createIncoming(input: CreateIncomingInput): Promise<InventoryTransactionWithItems> {
  return apiRequest<InventoryTransactionWithItems>("/inventory-transactions/incoming", {
    method: "POST",
    body: input,
  });
}

export function createOutgoing(input: CreateOutgoingInput): Promise<InventoryTransactionWithItems> {
  return apiRequest<InventoryTransactionWithItems>("/inventory-transactions/outgoing", {
    method: "POST",
    body: input,
  });
}

export function createTransfer(input: CreateTransferInput): Promise<InventoryTransactionWithItems> {
  return apiRequest<InventoryTransactionWithItems>("/inventory-transactions/transfer", {
    method: "POST",
    body: input,
  });
}

export function completeTransaction(id: number): Promise<InventoryTransactionWithItems> {
  return apiRequest<InventoryTransactionWithItems>(`/inventory-transactions/${id}/complete`, { method: "POST" });
}

export function cancelTransaction(id: number): Promise<InventoryTransactionWithItems> {
  return apiRequest<InventoryTransactionWithItems>(`/inventory-transactions/${id}/cancel`, { method: "POST" });
}

export function getTransactionDocumentPresignedUrl(id: number): Promise<{ url: string }> {
  return apiRequest<{ url: string }>(`/inventory-transactions/${id}/document/presigned-url`);
}

// Multipart upload — apiRequest() always sets Content-Type: application/json,
// which is wrong for FormData (the browser needs to set the multipart
// boundary itself), so this bypasses it and does the fetch directly,
// mirroring apiRequest()'s auth/error handling.
export async function attachTransactionDocument(id: number, file: File): Promise<InventoryTransactionWithItems> {
  const formData = new FormData();
  formData.append("file", file);

  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${API_URL}/inventory-transactions/${id}/document`, {
    method: "POST",
    headers,
    body: formData,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload ?? { statusCode: response.status, message: response.statusText, error: "Error" }, response.status);
  }
  return payload as InventoryTransactionWithItems;
}
