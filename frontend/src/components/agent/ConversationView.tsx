import { AgentMark } from "./AgentMark";
import { ResponseRenderer } from "./ResponseRenderer";
import { StreamingCursor, StreamingStatus } from "./StreamingStatus";
import type { AgentMessage, AgentStreamStatus } from "../../types/agent";

interface ConversationViewProps {
  messages: AgentMessage[];
  streamingStatus: AgentStreamStatus | null;
  streamingText: string;
  compact?: boolean;
}

function UserBubble({ message, compact }: { message: AgentMessage; compact?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", animation: "agent-msg-in 0.22s ease-out" }}>
      <div
        style={{
          maxWidth: compact ? "82%" : "70%",
          background: "var(--color-accent)",
          color: "var(--color-on-accent)",
          borderRadius: "14px 14px 3px 14px",
          padding: compact ? "8px 12px" : "10px 14px",
          fontSize: compact ? 12.5 : 13.5,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 2px 10px rgba(0,0,0,0.12)",
        }}
      >
        {message.text}
      </div>
    </div>
  );
}

function AgentBubble({ message, compact }: { message: AgentMessage; compact?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", animation: "agent-msg-in 0.22s ease-out" }}>
      <AgentMark size={compact ? 24 : 30} />
      <div
        style={{
          maxWidth: compact ? "88%" : "78%",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "3px 14px 14px 14px",
          padding: compact ? "8px 12px" : "12px 14px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        }}
      >
        <p style={{ fontSize: compact ? 12.5 : 13.5, color: "var(--color-text)", lineHeight: 1.55, margin: 0, whiteSpace: "pre-wrap" }}>
          {message.text}
        </p>
        {message.blocks && message.blocks.length > 0 && <ResponseRenderer blocks={message.blocks} />}
      </div>
    </div>
  );
}

function StreamingBubble({ status, text, compact }: { status: AgentStreamStatus | null; text: string; compact?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <AgentMark size={compact ? 24 : 30} pulsing />
      <div
        style={{
          maxWidth: compact ? "88%" : "78%",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "3px 14px 14px 14px",
          padding: compact ? "8px 12px" : "12px 14px",
          minWidth: 60,
          boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        }}
      >
        {text.length === 0 && status ? (
          <StreamingStatus status={status} />
        ) : (
          <p style={{ fontSize: compact ? 12.5 : 13.5, color: "var(--color-text)", lineHeight: 1.55, margin: 0, whiteSpace: "pre-wrap" }}>
            {text}
            <StreamingCursor />
          </p>
        )}
      </div>
    </div>
  );
}

export function ConversationView({ messages, streamingStatus, streamingText, compact }: ConversationViewProps) {
  const isStreaming = streamingStatus !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 12 : 16 }}>
      {messages.map((message) =>
        message.role === "user" ? (
          <UserBubble key={message.id} message={message} compact={compact} />
        ) : (
          <AgentBubble key={message.id} message={message} compact={compact} />
        ),
      )}
      {isStreaming && <StreamingBubble status={streamingStatus} text={streamingText} compact={compact} />}
    </div>
  );
}
