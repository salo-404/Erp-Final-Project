import type { AgentQuickAction } from "../../types/agent";

interface QuickActionChipsProps {
  actions: AgentQuickAction[];
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}

export function QuickActionChips({ actions, onSelect, disabled }: QuickActionChipsProps) {
  if (actions.length === 0) return null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(action.prompt)}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "7px 12px",
            borderRadius: 20,
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
