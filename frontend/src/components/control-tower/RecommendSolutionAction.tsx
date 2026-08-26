import { useRef, useState } from "react";
import { agentCoreService } from "../../agent/agentCoreService";
import { useAuth } from "../../auth/AuthContext";
import { AgentMark } from "../agent/AgentMark";
import { AgentMarkdown } from "../agent/AgentMarkdown";
import { StreamingCursor, StreamingStatus } from "../agent/StreamingStatus";
import { useTypewriter } from "../agent/useTypewriter";
import { CATEGORY_LABELS } from "../../lib/controlTowerStats";
import type { AgentConversation, AgentStreamStatus } from "../../types/agent";
import type { ControlTowerAlert } from "../../types/domain";

interface RecommendSolutionActionProps {
  alert: ControlTowerAlert;
  /** Already-resolved product/warehouse label, e.g. "Wireless Mouse — Beirut Warehouse". */
  title: string;
}

// Reuses the exact same AI transport (agentCoreService) and streaming/
// typewriter UI (StreamingStatus, AgentMarkdown, useTypewriter) already
// built for chat - not a new agent, not a new backend endpoint. Each click
// mints its own throwaway AgentConversation id, so agentCoreService's
// existing session-per-conversation isolation (see agentcore_entrypoint.py)
// keeps this fully separate from the user's real chat history - nothing
// here is persisted to localStorage or the AgentContext conversation list.
function buildAlertPrompt(alert: ControlTowerAlert, title: string): string {
  return (
    `Control Tower flagged this ${alert.severity} ${CATEGORY_LABELS[alert.category]} alert: ` +
    `"${alert.message}" (concerning ${title}). Using real, current inventory and supplier data, ` +
    `what is the single best, specific solution to fix this? Give one clear, concrete ` +
    `recommendation with real numbers - not general advice.`
  );
}

export function RecommendSolutionAction({ alert, title }: RecommendSolutionActionProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AgentStreamStatus | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hasRunRef = useRef(false);

  const isStreaming = status !== null;
  const revealed = useTypewriter(text, isStreaming);

  async function runRecommendation() {
    if (!user || isStreaming) return;
    setStatus("Analyzing...");
    setError(null);
    setText("");

    const now = new Date().toISOString();
    const conversation: AgentConversation = {
      id: crypto.randomUUID(),
      title: "Control Tower recommendation",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    try {
      for await (const event of agentCoreService.sendMessage({
        conversation,
        userMessage: buildAlertPrompt(alert, title),
        pageContext: { path: "/control-tower", label: "Control Tower", quickActions: [] },
        userId: user.id,
      })) {
        if (event.type === "status") {
          setStatus(event.status);
        } else if (event.type === "token") {
          setText((prev) => prev + event.token);
        } else if (event.type === "done") {
          setStatus(null);
        } else if (event.type === "error") {
          setStatus(null);
          setError(event.error);
        }
      }
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : "The assistant hit an unexpected error.");
    }
  }

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && !hasRunRef.current) {
      hasRunRef.current = true;
      runRecommendation();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        onClick={handleToggle}
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          padding: "8px 14px",
          borderRadius: 6,
          border: "1px solid var(--color-accent)",
          background: "transparent",
          color: "var(--color-accent)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          whiteSpace: "nowrap",
        }}
      >
        <AgentMark size={14} pulsing={isStreaming} />
        Recommend Solution
      </div>

      {open && (
        <div
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "12px 14px",
            fontSize: 12.5,
            maxWidth: 480,
          }}
        >
          {error ? (
            <div>
              <div style={{ color: "var(--color-danger)", marginBottom: 6 }}>{error}</div>
              <div onClick={runRecommendation} style={{ color: "var(--color-accent)", fontWeight: 600, cursor: "pointer" }}>
                Try again
              </div>
            </div>
          ) : isStreaming && revealed.length === 0 ? (
            <StreamingStatus status={status!} />
          ) : (
            <div>
              <AgentMarkdown text={revealed} />
              {isStreaming && <StreamingCursor />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
