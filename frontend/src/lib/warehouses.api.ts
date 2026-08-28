import { apiRequest } from "./api-client";
import type {
  CreateWarehouseInput,
  ProductAvailability,
  UpdateWarehouseInput,
  Warehouse,
  WarehouseAvailability,
  WarehouseCapacity,
  WarehouseCatalog,
  WarehouseInventoryWithWarehouse,
  WarehouseReservedTotal,
} from "../types/domain";

export function listWarehouses(): Promise<Warehouse[]> {
  return apiRequest<Warehouse[]>("/warehouses");
}

export function getWarehouseCatalog(warehouseId: number): Promise<WarehouseCatalog> {
  return apiRequest<WarehouseCatalog>(`/warehouses/${warehouseId}/catalog`);
}

export function getWarehouseCapacity(warehouseId: number): Promise<WarehouseCapacity> {
  return apiRequest<WarehouseCapacity>(`/warehouse-inventory/capacity/${warehouseId}`);
}

export function getWarehouseAvailability(warehouseId: number): Promise<WarehouseAvailability[]> {
  return apiRequest<WarehouseAvailability[]>(`/warehouse-inventory/warehouse/${warehouseId}/available`);
}

export function getWarehouseReservedTotal(warehouseId: number): Promise<WarehouseReservedTotal> {
  return apiRequest<WarehouseReservedTotal>(`/warehouse-inventory/warehouse/${warehouseId}/reserved`);
}

export function getInventoryByProduct(productId: number): Promise<WarehouseInventoryWithWarehouse[]> {
  return apiRequest<WarehouseInventoryWithWarehouse[]>(`/warehouse-inventory/product/${productId}`);
}

export function getProductAvailability(warehouseId: number, productId: number): Promise<ProductAvailability> {
  return apiRequest<ProductAvailability>(`/warehouse-inventory/available/${warehouseId}/${productId}`);
}

export function createWarehouse(input: CreateWarehouseInput): Promise<Warehouse> {
  return apiRequest<Warehouse>("/warehouses", { method: "POST", body: input });
}

export function updateWarehouse(id: number, input: UpdateWarehouseInput): Promise<Warehouse> {
  return apiRequest<Warehouse>(`/warehouses/${id}`, { method: "PATCH", body: input });
}

export function deleteWarehouse(id: number): Promise<Warehouse> {
  return apiRequest<Warehouse>(`/warehouses/${id}`, { method: "DELETE" });
}
