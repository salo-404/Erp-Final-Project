import { useMemo, useState } from "react";
import { CreateOrderModal } from "../components/CreateOrderModal";
import { useAppData } from "../data/AppDataContext";
import type { Product } from "../types";

interface WarehouseDetailPageProps {
  warehouseId: string;
  onBack: () => void;
}

/** Inventory view for one warehouse - products grouped into collapsible category sections. */
export function WarehouseDetailPage({ warehouseId, onBack }: WarehouseDetailPageProps) {
  const { warehouses, products, suppliers, createOrder } = useAppData();
  const warehouse = warehouses.find((item) => item.id === warehouseId);
  const [orderTarget, setOrderTarget] = useState<Product | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const categories = useMemo(() => {
    const warehouseProducts = products.filter((product) => product.warehouseId === warehouseId);
    const grouped = new Map<string, Product[]>();
    for (const product of warehouseProducts) {
      const bucket = grouped.get(product.category) ?? [];
      bucket.push(product);
      grouped.set(product.category, bucket);
    }
    return Array.from(grouped.entries());
  }, [products, warehouseId]);

  function toggleCategory(category: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  if (!warehouse) {
    return (
      <div className="text-sm text-zinc-500">
        Warehouse not found.{" "}
        <button type="button" onClick={onBack} className="text-indigo-400 hover:underline">
          Back to Warehouses
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 flex w-fit items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
      >
        ← Back to Warehouses
      </button>

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">{warehouse.name}</h1>
        <p className="text-sm text-zinc-500">
          {warehouse.location} · {warehouse.capacity.toLocaleString()} capacity
        </p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto">
        {categories.map(([category, categoryProducts]) => {
          const isCollapsed = collapsedCategories.has(category);
          return (
            <div
              key={category}
              className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950"
            >
              <button
                type="button"
                onClick={() => toggleCategory(category)}
                className="flex w-full items-center justify-between px-4 py-3"
              >
                <span className="text-sm font-medium text-zinc-200">{category}</span>
                <span className="flex items-center gap-2 text-xs text-zinc-500">
                  {categoryProducts.length} products
                  <span className={`transition-transform ${isCollapsed ? "" : "rotate-180"}`}>
                    ▾
                  </span>
                </span>
              </button>

              {!isCollapsed && (
                <ul className="divide-y divide-zinc-900 border-t border-zinc-900">
                  {categoryProducts.map((product) => (
                    <li
                      key={product.id}
                      className="flex items-center justify-between px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium text-zinc-200">{product.name}</p>
                        <p className="text-xs text-zinc-500">
                          {product.quantityOnHand} on hand
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setOrderTarget(product)}
                        className="rounded-lg border border-indigo-800 bg-indigo-950 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-900"
                      >
                        Create Order
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {orderTarget && (
        <CreateOrderModal
          product={orderTarget}
          suppliers={suppliers}
          onClose={() => setOrderTarget(null)}
          onSubmit={({ amount, supplierId }) =>
            createOrder({ warehouseId, productId: orderTarget.id, amount, supplierId })
          }
        />
      )}
    </div>
  );
}
