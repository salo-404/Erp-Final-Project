import { useState } from "react";
import { WarehouseFormModal } from "../components/WarehouseFormModal";
import { useAppData } from "../data/AppDataContext";
import type { Warehouse } from "../types";

interface WarehousesPageProps {
  onOpenWarehouse: (warehouseId: string) => void;
}

/**
 * Warehouses list view. Create/Edit/Delete here mutate local mock state
 * only - see the MERGE-BACKEND comment in data/AppDataContext.tsx for what
 * these should call once a real backend exists.
 */
export function WarehousesPage({ onOpenWarehouse }: WarehousesPageProps) {
  const { warehouses, products, createWarehouse, updateWarehouse, deleteWarehouse } =
    useAppData();
  const [formTarget, setFormTarget] = useState<"new" | Warehouse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Warehouse | null>(null);

  function productCount(warehouseId: string): number {
    return products.filter((product) => product.warehouseId === warehouseId).length;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Warehouses</h1>
          <p className="text-sm text-zinc-500">{warehouses.length} warehouses</p>
        </div>
        <button
          type="button"
          onClick={() => setFormTarget("new")}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          + New Warehouse
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
        {warehouses.map((warehouse) => (
          <div
            key={warehouse.id}
            className="group flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-5 transition hover:border-zinc-700"
          >
            <button
              type="button"
              onClick={() => onOpenWarehouse(warehouse.id)}
              className="text-left"
            >
              <h3 className="text-base font-semibold text-zinc-100 group-hover:text-white">
                {warehouse.name}
              </h3>
              <p className="mt-0.5 text-sm text-zinc-500">{warehouse.location}</p>
            </button>

            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>{productCount(warehouse.id)} product lines</span>
              <span>{warehouse.capacity.toLocaleString()} capacity</span>
            </div>

            <div className="mt-1 flex gap-2 border-t border-zinc-900 pt-3">
              <button
                type="button"
                onClick={() => setFormTarget(warehouse)}
                className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(warehouse)}
                className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium text-red-400/80 hover:bg-red-950 hover:text-red-300"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {formTarget && (
        <WarehouseFormModal
          warehouse={formTarget === "new" ? undefined : formTarget}
          onClose={() => setFormTarget(null)}
          onSubmit={(input) => {
            if (formTarget === "new") {
              createWarehouse(input);
            } else {
              updateWarehouse(formTarget.id, input);
            }
          }}
        />
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-base font-semibold text-zinc-100">Delete warehouse?</h2>
            <p className="mt-2 text-sm text-zinc-400">
              This removes <span className="font-medium text-zinc-200">{pendingDelete.name}</span>{" "}
              from local mock state. This cannot be undone here.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteWarehouse(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
