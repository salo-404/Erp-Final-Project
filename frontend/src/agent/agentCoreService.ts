import { AGENTCORE_URL } from "../lib/env";
import { getStoredToken } from "../lib/api-client";
import type { AgentMessage, AgentSendMessageParams, AgentService, AgentStreamEvent } from "../types/agent";

// Real transport for ai-agent/agentcore_entrypoint.py (`POST /invocations`,
// run locally via `python agentcore_entrypoint.py`, default port 8080 — see
// ai-agent/README.md). Satisfies the same AgentService interface as
// agentService.ts's mock, so no other UI code changes.

// Canonical runtime session ID format required by
// _validate_session_owner()/parse_runtime_session_owner() in
// ai-agent/agentcore_session.py: "erp-user-{id}-{32-lowercase-hex-uuid}".
// crypto.randomUUID() (used for AgentConversation.id) already produces a
// 32-lowercase-hex UUID once dashes are stripped.
function runtimeSessionId(userId: number, conversationId: string): string {
  return `erp-user-${userId}-${conversationId.replace(/-/g, "")}`;
}

interface AgentCoreEvent {
  type: "text_delta" | "tool_status" | "done" | "error";
  text?: string;
  label?: string;
  message?: string;
}

// The public stream only ever emits text_delta/tool_status/done/error (see
// the `invoke()` docstring in agentcore_entrypoint.py) — no blocks events.
// StreamingBubble (components/agent/ConversationView.tsx) already falls
// back to showing the live status only while streamingText is still empty,
// so tool_status labels naturally stop mattering once real text starts.
async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentCoreEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonText = trimmed.slice(5).trim();
        if (!jsonText) continue;
        try {
          yield JSON.parse(jsonText) as AgentCoreEvent;
        } catch {
          // Not a JSON event line — ignore rather than fail the whole stream.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function* agentCoreSendMessage(params: AgentSendMessageParams): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const { conversation, userMessage, pageContext, userId } = params;

  const token = getStoredToken();
  if (!token) {
    throw new Error("You're not signed in — please sign in again.");
  }

  let response: Response;
  try {
    response = await fetch(`${AGENTCORE_URL}/invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": runtimeSessionId(userId, conversation.id),
      },
      body: JSON.stringify({ prompt: userMessage }),
    });
  } catch {
    throw new Error(`Could not reach the AI service at ${AGENTCORE_URL} — is it running locally?`);
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `AI service returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${detail ? `: ${detail}` : ""}`,
    );
  }

  yield { type: "status", status: "Thinking..." };

  let streamed = "";
  for await (const event of parseSseStream(response.body)) {
    if (event.type === "text_delta" && event.text) {
      streamed += event.text;
      yield { type: "token", token: event.text };
    } else if (event.type === "tool_status" && event.label) {
      yield { type: "status", status: event.label };
    } else if (event.type === "error") {
      yield { type: "error", error: event.message ?? "The assistant hit an unexpected error." };
      return;
    } else if (event.type === "done") {
      const message: AgentMessage = {
        id: crypto.randomUUID(),
        role: "agent",
        createdAt: new Date().toISOString(),
        text: streamed,
        pageContextLabel: pageContext.label,
      };
      yield { type: "done", message };
      return;
    }
  }

  // Stream closed without a "done" event (connection dropped mid-response).
  if (streamed) {
    yield {
      type: "done",
      message: {
        id: crypto.randomUUID(),
        role: "agent",
        createdAt: new Date().toISOString(),
        text: streamed,
        pageContextLabel: pageContext.label,
      },
    };
  } else {
    yield { type: "error", error: "The connection to the AI service closed unexpectedly." };
  }
}

export const agentCoreService: AgentService = {
  sendMessage: agentCoreSendMessage,
};
