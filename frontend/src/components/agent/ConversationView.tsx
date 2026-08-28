import { useEffect, useRef, useState } from "react";
import { AgentMark } from "./AgentMark";
import { AgentMarkdown } from "./AgentMarkdown";
import { ResponseRenderer } from "./ResponseRenderer";
import { StreamingCursor, StreamingStatus } from "./StreamingStatus";
import { useTypewriter } from "./useTypewriter";
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
        <div style={{ fontSize: compact ? 12.5 : 13.5 }}>
          <AgentMarkdown text={message.text} />
        </div>
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
          <div style={{ fontSize: compact ? 12.5 : 13.5 }}>
            <AgentMarkdown text={text} />
            <StreamingCursor />
          </div>
        )}
      </div>
    </div>
  );
}

export function ConversationView({ messages, streamingStatus, streamingText, compact }: ConversationViewProps) {
  const isStreaming = streamingStatus !== null;
  const lastMessage = messages[messages.length - 1];

  // "Settling": the brief window right after streaming ends where the
  // paced reveal (see useTypewriter) may still be a little behind the now-
  // final message text. Keeping the same tail bubble/typewriter instance
  // through this transition (rather than swapping to a fresh AgentBubble
  // the instant "done" fires) avoids a double-animation glitch — the text
  // would otherwise finish typing once as the streaming bubble, then
  // instantly restart typing again as the newly-mounted static bubble.
  const wasStreamingRef = useRef(false);
  const [settlingMessageId, setSettlingMessageId] = useState<string | null>(null);

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && lastMessage?.role === "agent") {
      setSettlingMessageId(lastMessage.id);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, lastMessage]);

  const isSettling = !isStreaming && settlingMessageId !== null && lastMessage?.id === settlingMessageId;
  const tailTarget = isStreaming ? streamingText : isSettling ? lastMessage!.text : "";
  const tailActive = isStreaming || isSettling;
  const revealed = useTypewriter(tailTarget, tailActive);

  useEffect(() => {
    if (isSettling && revealed.length >= tailTarget.length) {
      setSettlingMessageId(null);
    }
  }, [isSettling, revealed, tailTarget]);

  // Only drop the last message from the normal list while settling — that's
  // when it's the agent's own just-finalized message, still being revealed
  // by the tail bubble in its place. While plain isStreaming (before "done"),
  // the last message is the user's own — it must render normally, with the
  // tail bubble appended after it, not instead of it.
  const showAnimatedTail = isStreaming || isSettling;
  const staticMessages = isSettling ? messages.slice(0, -1) : messages;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 12 : 16 }}>
      {staticMessages.map((message) =>
        message.role === "user" ? (
          <UserBubble key={message.id} message={message} compact={compact} />
        ) : (
          <AgentBubble key={message.id} message={message} compact={compact} />
        ),
      )}
      {showAnimatedTail && <StreamingBubble status={isStreaming ? streamingStatus : null} text={revealed} compact={compact} />}
    </div>
  );
}
