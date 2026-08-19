import { useState, type FormEvent } from "react";
import type { Warehouse } from "../types";
import { Modal } from "./Modal";

interface WarehouseFormModalProps {
  /** Present when editing an existing warehouse; absent when creating a new one. */
  warehouse?: Warehouse;
  onClose: () => void;
  onSubmit: (input: { name: string; location: string; capacity: number }) => void;
}

/**
 * Create/Edit form for a Warehouse.
 *
 * MERGE-BACKEND: onSubmit above (wired from WarehousesPage into
 * AppDataContext's createWarehouse/updateWarehouse) should be replaced with
 * real calls to the backend's Warehouses CRUD endpoints - see
 * Backend_vs_AI_Work_Split.md "Products, Warehouses, Suppliers". This form
 * itself needs no changes for that swap; only what onSubmit does changes.
 */
export function WarehouseFormModal({ warehouse, onClose, onSubmit }: WarehouseFormModalProps) {
  const [name, setName] = useState(warehouse?.name ?? "");
  const [location, setLocation] = useState(warehouse?.location ?? "");
  const [capacity, setCapacity] = useState(warehouse?.capacity?.toString() ?? "");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsedCapacity = Number(capacity);
    if (!name.trim() || !location.trim() || !Number.isFinite(parsedCapacity)) return;
    onSubmit({ name: name.trim(), location: location.trim(), capacity: parsedCapacity });
    onClose();
  }

  return (
    <Modal title={warehouse ? "Edit Warehouse" : "Create Warehouse"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Name</label>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Leeds South"
            required
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Location</label>
          <input
            type="text"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="e.g. Leeds, UK"
            required
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            Capacity (units)
          </label>
          <input
            type="number"
            min={0}
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
            placeholder="e.g. 4000"
            required
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {warehouse ? "Save Changes" : "Create Warehouse"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
