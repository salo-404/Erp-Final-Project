import { apiRequest } from "./api-client";
import type {
  ProductDemand,
  ProductMovementStat,
  PurchaseTrendPoint,
  SalesTrendPoint,
  StockHistoryEntry,
  SupplierComparisonEntry,
  WarehouseDemand,
} from "../types/domain";

export interface TopSellingProduct {
  productId: number;
  name: string;
  totalQuantitySold: number;
  totalRevenue: number;
}

function withWarehouseParam(path: string, warehouseId?: number): string {
  return warehouseId !== undefined ? `${path}?warehouseId=${warehouseId}` : path;
}

export function getTopSellingProducts(warehouseId?: number): Promise<TopSellingProduct[]> {
  return apiRequest<TopSellingProduct[]>(withWarehouseParam("/analytics/top-selling-products", warehouseId));
}

export function getLowestSellingProducts(warehouseId?: number): Promise<TopSellingProduct[]> {
  return apiRequest<TopSellingProduct[]>(withWarehouseParam("/analytics/lowest-selling-products", warehouseId));
}

export function getFastMovingProducts(days?: number, warehouseId?: number): Promise<ProductMovementStat[]> {
  const params = new URLSearchParams();
  if (days !== undefined) params.set("days", String(days));
  if (warehouseId !== undefined) params.set("warehouseId", String(warehouseId));
  const qs = params.toString();
  return apiRequest<ProductMovementStat[]>(`/analytics/fast-moving-products${qs ? `?${qs}` : ""}`);
}

export function getSlowMovingProducts(days?: number, warehouseId?: number): Promise<ProductMovementStat[]> {
  const params = new URLSearchParams();
  if (days !== undefined) params.set("days", String(days));
  if (warehouseId !== undefined) params.set("warehouseId", String(warehouseId));
  const qs = params.toString();
  return apiRequest<ProductMovementStat[]>(`/analytics/slow-moving-products${qs ? `?${qs}` : ""}`);
}

export function getSalesTrends(warehouseId?: number): Promise<SalesTrendPoint[]> {
  return apiRequest<SalesTrendPoint[]>(withWarehouseParam("/analytics/sales-trends", warehouseId));
}

export function getPurchaseTrends(warehouseId?: number): Promise<PurchaseTrendPoint[]> {
  return apiRequest<PurchaseTrendPoint[]>(withWarehouseParam("/analytics/purchase-trends", warehouseId));
}

export function getStockHistory(productId: number): Promise<StockHistoryEntry[]> {
  return apiRequest<StockHistoryEntry[]>(`/analytics/stock-history/${productId}`);
}

export function getWarehouseDemand(warehouseId?: number): Promise<WarehouseDemand[]> {
  return apiRequest<WarehouseDemand[]>(withWarehouseParam("/analytics/warehouse-demand", warehouseId));
}

export function getProductDemand(productId: number): Promise<ProductDemand> {
  return apiRequest<ProductDemand>(`/analytics/product-demand/${productId}`);
}

export function getSupplierComparison(): Promise<SupplierComparisonEntry[]> {
  return apiRequest<SupplierComparisonEntry[]>("/analytics/supplier-comparison");
}
