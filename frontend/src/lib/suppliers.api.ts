import { apiRequest } from "./api-client";
import type { CreateSupplierInput, Supplier, SupplierTransactionHistory, UpdateSupplierInput } from "../types/domain";

export function listSuppliers(): Promise<Supplier[]> {
  return apiRequest<Supplier[]>("/suppliers");
}

export function getSupplier(id: number): Promise<Supplier> {
  return apiRequest<Supplier>(`/suppliers/${id}`);
}

export function getSupplierTransactionHistory(id: number): Promise<SupplierTransactionHistory> {
  return apiRequest<SupplierTransactionHistory>(`/suppliers/${id}/transactions`);
}

export function createSupplier(input: CreateSupplierInput): Promise<Supplier> {
  return apiRequest<Supplier>("/suppliers", { method: "POST", body: input });
}

export function updateSupplier(id: number, input: UpdateSupplierInput): Promise<Supplier> {
  return apiRequest<Supplier>(`/suppliers/${id}`, { method: "PATCH", body: input });
}

export function deleteSupplier(id: number): Promise<Supplier> {
  return apiRequest<Supplier>(`/suppliers/${id}`, { method: "DELETE" });
}
