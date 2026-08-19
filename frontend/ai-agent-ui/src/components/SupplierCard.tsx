import type { SupplierNarration } from "../types";

interface SupplierCardProps {
  supplier: SupplierNarration;
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const percent = Math.round(value * 100);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{label}</span>
        <span className="font-medium text-slate-700 dark:text-slate-200">
          {percent}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className="h-1.5 rounded-full bg-indigo-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Renders one SupplierNarration exactly as returned by
 * ai-agent/narration/supplier_analysis.py's narrate_supplier() - see
 * ai-agent/tools/schemas/supplier_schema.py for the field contract
 * (unit_cost, lead_time_days, reliability_score, overall_score, narrative,
 * recommendation_context, etc.).
 */
export function SupplierCard({ supplier }: SupplierCardProps) {
  return (
    <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {supplier.name}
          </h3>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {supplier.product_categories.join(" · ")}
          </p>
        </div>
        <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
          {Math.round(supplier.overall_score * 100)}% overall
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-slate-400 dark:text-slate-500">Unit cost</p>
          <p className="font-medium text-slate-700 dark:text-slate-200">
            ${supplier.unit_cost.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-400 dark:text-slate-500">Lead time</p>
          <p className="font-medium text-slate-700 dark:text-slate-200">
            {supplier.lead_time_days} days
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Recent transactions
          </p>
          <p className="font-medium text-slate-700 dark:text-slate-200">
            {supplier.recent_transaction_count}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            On-time delivery
          </p>
          <p className="font-medium text-slate-700 dark:text-slate-200">
            {Math.round(supplier.on_time_delivery_rate * 100)}%
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <ScoreBar label="Reliability" value={supplier.reliability_score} />
        <ScoreBar label="Overall score" value={supplier.overall_score} />
      </div>

      <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
        {supplier.narrative}
      </p>

      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        {supplier.recommendation_context}
      </div>
    </div>
  );
}
