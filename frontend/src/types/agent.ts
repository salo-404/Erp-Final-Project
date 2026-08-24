// Types for the AI Agent feature. Kept independent of any specific transport
// so the real streaming implementation (agent/agentCoreService.ts) can be
// swapped without touching these shapes or any UI component.

export type AgentRole = "user" | "agent";

// A live, human-readable label describing what the agent is doing right
// now (e.g. "Checking available stock..."). Comes straight from the
// backend's real tool-call activity (see agentcore_entrypoint.py's
// tool_status event) — never a fixed/guessed set of phases.
export type AgentStreamStatus = string;

export type AgentBlockTone = "default" | "success" | "warning" | "danger";

export interface AgentAction {
  id: string;
  label: string;
  to?: string;
  kind?: "primary" | "secondary";
}

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "kpis"; items: { label: string; value: string; tone?: AgentBlockTone }[] }
  | { type: "table"; columns: string[]; rows: Array<Array<string | number>> }
  | {
      type: "recommendation";
      title: string;
      description: string;
      tone?: AgentBlockTone;
      stats?: { label: string; value: string }[];
      actions?: AgentAction[];
    }
  | { type: "link"; label: string; to: string };

export interface AgentMessage {
  id: string;
  role: AgentRole;
  createdAt: string;
  text: string;
  blocks?: AgentContentBlock[];
  pageContextLabel?: string;
}

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
}

export interface AgentQuickAction {
  id: string;
  label: string;
  prompt: string;
}

export interface AgentPageContext {
  path: string;
  label: string;
  quickActions: AgentQuickAction[];
}

export type AgentStreamEvent =
  | { type: "status"; status: AgentStreamStatus }
  | { type: "token"; token: string }
  | { type: "blocks"; blocks: AgentContentBlock[] }
  | { type: "done"; message: AgentMessage }
  | { type: "error"; error: string };

export interface AgentSendMessageParams {
  conversation: AgentConversation;
  userMessage: string;
  pageContext: AgentPageContext;
  /** Authenticated ERP user id — namespaces the AgentCore runtime session ID so the backend can enforce session ownership. */
  userId: number;
}

export interface AgentService {
  sendMessage(params: AgentSendMessageParams): AsyncGenerator<AgentStreamEvent, void, unknown>;
}
