import { useState } from "react";
import type { ToolTrace } from "../types";

interface ToolTraceViewProps {
  trace: ToolTrace[];
  /** Optional label for what this trace belongs to, e.g. a query summary. */
  title?: string;
}

/**
 * Collapsible list of tool calls an agent made while handling one query -
 * "what the agent actually did", derived from a Strands AgentResult's
 * .messages toolUse/toolResult entries (see any test in ai-agent/tests/
 * that inspects agent.messages for the parsing pattern this data comes
 * from).
 */
export function ToolTraceView({ trace, title = "Tool trace" }: ToolTraceViewProps) {
  const [expanded, setExpanded] = useState(false);

  const errorCount = trace.filter((step) => step.status === "error").length;

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {title}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {trace.length} call{trace.length === 1 ? "" : "s"}
          </span>
          {errorCount > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
              {errorCount} error{errorCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <span
          className={`text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {expanded && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {trace.map((step, index) => (
            <li key={index} className="flex items-start gap-3 px-4 py-3">
              <span
                className={`mt-0.5 h-2 w-2 flex-shrink-0 rounded-full ${
                  step.status === "success" ? "bg-emerald-500" : "bg-red-500"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs font-medium text-slate-700 dark:text-slate-200">
                  {step.toolName}
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  {step.summary}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
