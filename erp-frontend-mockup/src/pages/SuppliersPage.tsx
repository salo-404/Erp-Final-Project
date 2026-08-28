import { useAppData } from "../data/AppDataContext";

/**
 * Minimal placeholder - a basic name list, not a real supplier profile.
 *
 * MERGE-AI: replace this whole page with the real SupplierCard component
 * from ai-agent-ui/src/components/SupplierCard.tsx, fed by
 * ai-agent/narration/supplier_analysis.py's real output (see
 * ai-agent/tools/schemas/supplier_schema.py for the SupplierNarration shape
 * that component expects - unit_cost, lead_time_days, reliability_score,
 * etc.). Not duplicated here on purpose - see README.md.
 */
export function SuppliersPage() {
  const { suppliers } = useAppData();

  return (
    <div className="flex h-full flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Suppliers</h1>
        <p className="text-sm text-zinc-500">Basic list - real profiles coming soon</p>
      </div>

      <ul className="max-w-md space-y-2 overflow-y-auto">
        {suppliers.map((supplier) => (
          <li
            key={supplier.id}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-200"
          >
            {supplier.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
