import agentLogo from "../../assets/ai-agent-logo.png";

interface AgentMarkProps {
  size: number;
  ring?: boolean;
  pulsing?: boolean;
  style?: React.CSSProperties;
}

// Square badge for the Nexora AI Agent mascot artwork — the source art is
// already a square composition, so it's shown in full (no cropping) with
// rounded corners scaled to the badge size, matching the app icon style.
export function AgentMark({ size, ring, pulsing, style }: AgentMarkProps) {
  const radius = Math.max(6, Math.round(size * 0.24));

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0, ...style }}>
      {pulsing && (
        <span
          style={{
            position: "absolute",
            inset: -3,
            borderRadius: radius + 3,
            border: "2px solid var(--color-accent)",
            animation: "agent-ring-ping 1.6s cubic-bezier(0,0,0.2,1) infinite",
          }}
        />
      )}
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          overflow: "hidden",
          border: ring ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        }}
      >
        <img src={agentLogo} alt="Nexora AI Agent" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
    </div>
  );
}
