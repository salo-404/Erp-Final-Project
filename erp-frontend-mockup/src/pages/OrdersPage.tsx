import { StatusBadge } from "../components/StatusBadge";
import { useAppData } from "../data/AppDataContext";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Global orders table across all warehouses.
 *
 * MERGE-AI: the "Invoice Received" and "Discrepancy Flagged" statuses shown
 * here are currently static mock values (see data/mockData.ts). Once real
 * invoice replies are ingested, these transitions should be driven by
 * ai-agent/agents/document_agent's extract_document(doc_type="invoice") and
 * detect_discrepancy() results, not set manually.
 */
export function OrdersPage() {
  const { orders } = useAppData();

  return (
    <div className="flex h-full flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Orders</h1>
        <p className="text-sm text-zinc-500">{orders.length} orders across all warehouses</p>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-zinc-950 text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-3 font-medium">Product</th>
              <th className="px-4 py-3 font-medium">Warehouse</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Supplier</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900">
            {orders.map((order) => (
              <tr key={order.id} className="bg-zinc-950/50 hover:bg-zinc-900/50">
                <td className="px-4 py-3 font-medium text-zinc-200">{order.productName}</td>
                <td className="px-4 py-3 text-zinc-400">{order.warehouseName}</td>
                <td className="px-4 py-3 text-zinc-400">{order.amount}</td>
                <td className="px-4 py-3 text-zinc-400">{order.supplierName}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={order.status} />
                </td>
                <td className="px-4 py-3 text-zinc-500">{formatDate(order.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
