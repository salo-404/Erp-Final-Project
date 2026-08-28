import { apiRequest } from "./api-client";
import type { RankedSupplier, SupplierStats } from "../types/domain";

export function getSupplierStats(supplierId: number): Promise<SupplierStats> {
  return apiRequest<SupplierStats>(`/supplier-intelligence/${supplierId}/stats`);
}

export function rankSuppliers(productId: number): Promise<RankedSupplier[]> {
  return apiRequest<RankedSupplier[]>(`/supplier-intelligence/rank?productId=${productId}`);
}

export function getBestSupplier(productId: number): Promise<RankedSupplier | null> {
  return apiRequest<RankedSupplier | null>(`/supplier-intelligence/best?productId=${productId}`);
}
