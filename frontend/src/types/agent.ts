// Types for the AI Agent feature. Kept independent of any specific transport
// so the mock service (agent/agentService.ts) can later be swapped for a
// real streaming API without touching these shapes or any UI component.

export type AgentRole = "user" | "agent";

export type AgentStreamStatus = "thinking" | "analyzing" | "checking-data" | "preparing";

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
}

export interface AgentService {
  sendMessage(params: AgentSendMessageParams): AsyncGenerator<AgentStreamEvent, void, unknown>;
}
