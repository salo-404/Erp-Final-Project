import { useState, type FormEvent } from "react";
import type { Product, Supplier } from "../types";
import { Modal } from "./Modal";

interface CreateOrderModalProps {
  product: Product;
  suppliers: Supplier[];
  onClose: () => void;
  onSubmit: (input: { amount: number; supplierId: string }) => void;
}

/**
 * Order-creation form, triggered from a product row in the warehouse
 * detail view. Product type is pre-filled and locked (the product clicked
 * determines it); amount and supplier are the only real inputs.
 *
 * MERGE-BACKEND: onSubmit (wired from WarehouseDetailPage into
 * AppDataContext's createOrder) should be replaced with a real call to the
 * backend's order/transaction creation endpoint plus its email service,
 * which is what actually notifies the supplier - see "Email / Calendar
 * services" in Backend_vs_AI_Work_Split.md. The success state below is a
 * UI-only simulation; no email is sent from this mockup.
 */
export function CreateOrderModal({
  product,
  suppliers,
  onClose,
  onSubmit,
}: CreateOrderModalProps) {
  const [amount, setAmount] = useState("");
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || !supplierId) return;

    onSubmit({ amount: parsedAmount, supplierId });
    const supplier = suppliers.find((item) => item.id === supplierId);
    setSentTo(supplier?.name ?? "the supplier");
  }

  if (sentTo) {
    return (
      <Modal title="Order Created" onClose={onClose}>
        <div className="space-y-4 text-center">
          <div className="text-3xl">✅</div>
          <p className="text-sm text-zinc-200">
            Order sent to <span className="font-semibold text-white">{sentTo}</span>.
          </p>
          <p className="text-xs text-zinc-500">
            (Mock only - no real email was sent. See the MERGE-BACKEND comment in
            CreateOrderModal.tsx.)
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create Order" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Product</label>
          <input
            type="text"
            value={product.name}
            disabled
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-400"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Amount</label>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="e.g. 25"
            required
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Supplier</label>
          <select
            value={supplierId}
            onChange={(event) => setSupplierId(event.target.value)}
            required
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          >
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
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
            Send Order
          </button>
        </div>
      </form>
    </Modal>
  );
}
