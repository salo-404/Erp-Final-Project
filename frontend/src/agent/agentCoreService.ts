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

// Shared POST /invocations + SSE-parse plumbing for both the normal chat
// path (agentCoreSendMessage) and any one-shot, non-conversational caller
// (sendControlTowerRecommendation) — same endpoint, same auth header, same
// event stream shape either way; only the request body and session ID
// differ (see agentcore_entrypoint.py's invoke() docstring for the "mode"
// field this optionally sends).
async function* streamInvocation(params: {
  sessionId: string;
  prompt: string;
  mode?: "control_tower_recommendation";
}): AsyncGenerator<AgentCoreEvent, void, unknown> {
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
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": params.sessionId,
      },
      body: JSON.stringify(params.mode ? { prompt: params.prompt, mode: params.mode } : { prompt: params.prompt }),
    });
  } catch {
    throw new Error("Can't reach the AI assistant right now. Please try again shortly.");
  }

  if (!response.ok || !response.body) {
    throw new Error("The AI assistant couldn't process that request. Please try again.");
  }

  yield* parseSseStream(response.body);
}

async function* agentCoreSendMessage(params: AgentSendMessageParams): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const { conversation, userMessage, pageContext, userId } = params;

  yield { type: "status", status: "Thinking..." };

  let streamed = "";
  for await (const event of streamInvocation({
    sessionId: runtimeSessionId(userId, conversation.id),
    prompt: userMessage,
  })) {
    if (event.type === "text_delta" && event.text) {
      streamed += event.text;
      yield { type: "token", token: event.text };
    } else if (event.type === "tool_status" && event.label) {
      // A tool call arriving AFTER some text already streamed means the
      // model abandoned that partial answer to start a fresh tool-calling
      // round (a real, observed behavior of this model — see
      // narration/control_tower_recommendation.py's own docstring for the
      // same model doing this elsewhere). It never resumes the old text;
      // it generates an entirely new answer once the tool result comes
      // back. Forwarding both halves concatenated is what makes the UI
      // look like the response "restarts" mid-stream — so the abandoned
      // draft is discarded here, not just visually hidden.
      if (streamed) {
        streamed = "";
        yield { type: "reset" };
      }
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

// One-shot, non-conversational AI call for Control Tower's "Recommend
// Solution" button (see components/control-tower/RecommendSolutionAction.tsx).
// Mints its own fresh session ID per call (never reused, never persisted),
// so it never touches the user's real chat history in AgentContext/
// localStorage, and sends "mode": "control_tower_recommendation" so
// agentcore_entrypoint.py routes it to the scripted, 3-scenario
// recommendation agent instead of the general Supervisor - see that
// module's invoke() docstring and narration/control_tower_recommendation.py.
export async function* sendControlTowerRecommendation(
  prompt: string,
  userId: number,
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  yield { type: "status", status: "Analyzing..." };

  let streamed = "";
  for await (const event of streamInvocation({
    sessionId: runtimeSessionId(userId, crypto.randomUUID()),
    prompt,
    mode: "control_tower_recommendation",
  })) {
    if (event.type === "text_delta" && event.text) {
      streamed += event.text;
      yield { type: "token", token: event.text };
    } else if (event.type === "tool_status" && event.label) {
      yield { type: "status", status: event.label };
    } else if (event.type === "error") {
      yield { type: "error", error: event.message ?? "The assistant hit an unexpected error." };
      return;
    } else if (event.type === "done") {
      yield {
        type: "done",
        message: { id: crypto.randomUUID(), role: "agent", createdAt: new Date().toISOString(), text: streamed },
      };
      return;
    }
  }

  if (streamed) {
    yield {
      type: "done",
      message: { id: crypto.randomUUID(), role: "agent", createdAt: new Date().toISOString(), text: streamed },
    };
  } else {
    yield { type: "error", error: "The connection to the AI service closed unexpectedly." };
  }
}
