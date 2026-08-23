import { getInventoryByProduct, getProductAvailability } from "./warehouses.api";

export interface ProductWarehouseStockRow {
  warehouseId: number;
  warehouseName: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderThreshold: number;
}

// Composes /warehouse-inventory/product/:id (which warehouses stock this
// product) with one /warehouse-inventory/available/:warehouseId/:productId
// call per warehouse (reservation-aware numbers) — there's no single bulk
// endpoint for "this product across every warehouse with reservations
// netted out", so this merges the two existing ones client-side.
export async function getProductStockByWarehouse(productId: number): Promise<ProductWarehouseStockRow[]> {
  const inventories = await getInventoryByProduct(productId);
  const availabilities = await Promise.all(
    inventories.map((inv) => getProductAvailability(inv.warehouseId, productId)),
  );

  return inventories.map((inv, i) => ({
    warehouseId: inv.warehouseId,
    warehouseName: inv.warehouse.name,
    onHand: inv.onHand,
    reserved: availabilities[i].reserved,
    available: availabilities[i].available,
    reorderThreshold: inv.reorderThreshold,
  }));
}
