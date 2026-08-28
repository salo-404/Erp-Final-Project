import type { AgentStreamStatus } from "../../types/agent";

export function StreamingStatus({ status }: { status: AgentStreamStatus }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
      <div style={{ display: "flex", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--color-accent)",
              display: "inline-block",
              animation: "agent-dot-pulse 1.1s ease-in-out infinite",
              animationDelay: `${i * 0.15}s`,
            }}
          />
        ))}
      </div>
      <span key={status} style={{ fontSize: 12.5, color: "var(--color-text-muted)", fontStyle: "italic", animation: "agent-msg-in 0.18s ease-out" }}>
        {status}
      </span>
    </div>
  );
}

export function StreamingCursor() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 2,
        height: 14,
        background: "var(--color-accent)",
        marginLeft: 2,
        verticalAlign: "middle",
        animation: "agent-cursor-blink 0.9s step-start infinite",
      }}
    />
  );
}
