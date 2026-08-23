import type {
  AgentContentBlock,
  AgentMessage,
  AgentSendMessageParams,
  AgentService,
  AgentStreamEvent,
  AgentStreamStatus,
} from "../types/agent";

// Mock agent service — simulates a real streaming assistant so the full UI
// (statuses, token-by-token rendering, structured responses) can be built and
// tested now. A real implementation only needs to satisfy the same
// `AgentService` interface (see types/agent.ts) — e.g. reading Server-Sent
// Events from a real backend endpoint — and can be swapped in wherever
// `mockAgentService` is currently imported (agent/AgentContext.tsx), with no
// changes required anywhere else in the UI.

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STATUS_SEQUENCE: AgentStreamStatus[] = ["thinking", "analyzing", "checking-data", "preparing"];

function buildIntro(pageLabel: string, userMessage: string): string {
  const trimmed = userMessage.trim();
  return `Here's how I'd approach that on the ${pageLabel} page once I'm connected to live ERP data: "${trimmed}"\n\nBelow is an example of the kind of structured answer I'll be able to give — real numbers will come from your actual data once the AI integration is wired in.`;
}

function pickDemoBlocks(userMessage: string): AgentContentBlock[] {
  const q = userMessage.toLowerCase();

  if (q.includes("low-stock") || q.includes("low stock") || q.includes("attention")) {
    return [
      { type: "text", text: "Example — products flagged as needing attention:" },
      {
        type: "recommendation",
        title: "Example: Product A",
        description: "Available stock is below the reorder threshold.",
        tone: "warning",
        stats: [
          { label: "Available", value: "8" },
          { label: "Reorder threshold", value: "20" },
        ],
        actions: [
          { id: "view-product", label: "View Product", to: "/inventory", kind: "secondary" },
          { id: "create-po", label: "Create Purchase Order", to: "/suppliers", kind: "primary" },
        ],
      },
    ];
  }

  if (q.includes("compare") || q.includes("capacity")) {
    return [
      {
        type: "table",
        columns: ["Warehouse", "Utilization", "Status"],
        rows: [
          ["Example Warehouse A", "82%", "Healthy"],
          ["Example Warehouse B", "97%", "Near capacity"],
        ],
      },
    ];
  }

  if (q.includes("supplier")) {
    return [
      {
        type: "kpis",
        items: [
          { label: "On-time rate", value: "91%", tone: "success" },
          { label: "Open orders", value: "6", tone: "default" },
          { label: "At risk", value: "1", tone: "warning" },
        ],
      },
    ];
  }

  if (q.includes("trend") || q.includes("changed") || q.includes("explain this data")) {
    return [
      { type: "bullets", items: ["Example trend: order volume up week over week", "Example trend: one category slowing down", "Example: a warehouse nearing capacity"] },
    ];
  }

  return [
    { type: "bullets", items: ["Summarize what's on this page", "Surface anything that needs attention", "Suggest a next action"] },
  ];
}

function buildOutro(pageLabel: string): string {
  return `\n\nThis is a preview of the response format — once connected, answers will reflect your real ${pageLabel} data.`;
}

async function* mockSendMessage(params: AgentSendMessageParams): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const { userMessage, pageContext } = params;

  for (const status of STATUS_SEQUENCE) {
    yield { type: "status", status };
    await delay(280 + Math.random() * 220);
  }

  const intro = buildIntro(pageContext.label, userMessage);
  const outro = buildOutro(pageContext.label);
  const fullText = intro + outro;

  const words = fullText.split(" ");
  let streamed = "";
  for (let i = 0; i < words.length; i++) {
    streamed += (i === 0 ? "" : " ") + words[i];
    yield { type: "token", token: (i === 0 ? "" : " ") + words[i] };
    await delay(14 + Math.random() * 26);
  }

  const blocks = pickDemoBlocks(userMessage);
  yield { type: "blocks", blocks };
  await delay(120);

  const message: AgentMessage = {
    id: crypto.randomUUID(),
    role: "agent",
    createdAt: new Date().toISOString(),
    text: streamed,
    blocks,
    pageContextLabel: pageContext.label,
  };

  yield { type: "done", message };
}

export const mockAgentService: AgentService = {
  sendMessage: mockSendMessage,
};
