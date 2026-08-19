/**
 * TypeScript mirrors of the AI layer's real Pydantic output shapes.
 *
 * Field names and types are kept in exact lockstep with their Python
 * source of truth - do not rename or reshape a field here without also
 * checking the corresponding schema file. Snake_case is used deliberately
 * (not camelCase) to match those schemas directly, so a payload from the
 * real backend can be passed into these components with zero transform.
 */

/** Mirrors AlertCategory in ai-agent/tools/schemas/control_tower_schema.py. */
export type AlertCategory =
  | "low_stock"
  | "stockout_risk"
  | "overdue_transaction"
  | "consumption_anomaly"
  | "expiring_inventory"
  | "invoice_discrepancy"
  | "order_discrepancy";

/** Mirrors AlertSeverity in ai-agent/tools/schemas/control_tower_schema.py. */
export type AlertSeverity = "low" | "medium" | "high" | "critical";

/** Mirrors Alert in ai-agent/tools/schemas/control_tower_schema.py. */
export interface Alert {
  id: string;
  category: AlertCategory;
  severity: AlertSeverity;
  /** Raw structured data backing the alert. Shape varies by category. */
  evidence: Record<string, unknown>;
  product_id: number | null;
  warehouse_id: number | null;
}

/**
 * Mirrors NarratedAlert in ai-agent/tools/schemas/control_tower_schema.py -
 * everything from Alert plus the two fields narrate_alert() generates.
 */
export interface NarratedAlert extends Alert {
  narrative: string;
  proposed_action: string;
}

/** Mirrors SupplierStats in ai-agent/tools/schemas/supplier_schema.py. */
export interface SupplierStats {
  supplier_id: number;
  name: string;
  unit_cost: number;
  lead_time_days: number;
  /** 0-1 */
  reliability_score: number;
  /** 0-1 */
  overall_score: number;
  recent_transaction_count: number;
  /** 0-1 */
  on_time_delivery_rate: number;
  product_categories: string[];
}

/**
 * Mirrors SupplierNarration in ai-agent/tools/schemas/supplier_schema.py -
 * everything from SupplierStats plus the two fields narrate_supplier()
 * generates.
 */
export interface SupplierNarration extends SupplierStats {
  narrative: string;
  recommendation_context: string;
}

/**
 * One turn in a Supervisor conversation. Not a Python schema - the
 * Supervisor's HTTP contract (see ai-agent/agentcore_entrypoint.py) is a
 * plain {"prompt": string} in / {"result": string} out; this is the shape
 * a chat UI accumulates client-side from that request/response pair.
 */
export interface ChatMessage {
  role: "user" | "supervisor";
  content: string;
}

/**
 * One tool call the Supervisor or a specialist agent made while handling a
 * query - the "what did the agent actually do" trace. Not a Python schema
 * itself; derived from a Strands AgentResult's .messages toolUse/toolResult
 * entries (see ai-agent's own test helpers for how those are parsed).
 */
export interface ToolTrace {
  toolName: string;
  status: "success" | "error";
  summary: string;
}
