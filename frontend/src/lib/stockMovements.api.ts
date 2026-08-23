import { apiRequest } from "./api-client";
import type { StockMovement, StockMovementType } from "../types/domain";

export interface LedgerFilters {
  warehouseId?: number;
  type?: StockMovementType;
  dateFrom?: string;
  dateTo?: string;
}

export function getLedger(filters: LedgerFilters): Promise<StockMovement[]> {
  const params = new URLSearchParams();
  if (filters.warehouseId !== undefined) params.set("warehouseId", String(filters.warehouseId));
  if (filters.type) params.set("type", filters.type);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);

  const qs = params.toString();
  return apiRequest<StockMovement[]>(`/stock-movements/ledger${qs ? `?${qs}` : ""}`);
}
