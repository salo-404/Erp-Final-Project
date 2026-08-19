import { useMemo, useState } from "react";
import type { AlertSeverity, NarratedAlert } from "../types";
import { AlertCard } from "./AlertCard";

interface ControlTowerDashboardProps {
  alerts: NarratedAlert[];
  onProposeAction?: (alert: NarratedAlert) => void;
}

const SEVERITY_FILTERS: Array<AlertSeverity | "all"> = [
  "all",
  "critical",
  "high",
  "medium",
  "low",
];

/**
 * Grid of AlertCard components rendering a batch of NarratedAlert records -
 * the output of ai-agent/narration/control_tower.py's batch narration pass
 * (see ai-agent/tools/schemas/control_tower_schema.py). The severity filter
 * is local UI state only; it does not refetch or re-narrate anything.
 */
export function ControlTowerDashboard({
  alerts,
  onProposeAction,
}: ControlTowerDashboardProps) {
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | "all">(
    "all",
  );

  const filteredAlerts = useMemo(
    () =>
      severityFilter === "all"
        ? alerts
        : alerts.filter((alert) => alert.severity === severityFilter),
    [alerts, severityFilter],
  );

  return (
    <div className="w-full">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {SEVERITY_FILTERS.map((severity) => (
          <button
            key={severity}
            type="button"
            onClick={() => setSeverityFilter(severity)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize transition ${
              severityFilter === severity
                ? "bg-indigo-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            }`}
          >
            {severity}
          </button>
        ))}
      </div>

      {filteredAlerts.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No alerts at this severity.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredAlerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onProposeAction={onProposeAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
