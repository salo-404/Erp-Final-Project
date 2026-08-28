import { Link } from "react-router-dom";
import type { AgentBlockTone, AgentContentBlock } from "../../types/agent";

function toneColor(tone: AgentBlockTone | undefined): string {
  switch (tone) {
    case "success":
      return "var(--color-success)";
    case "warning":
      return "var(--color-warning)";
    case "danger":
      return "var(--color-danger)";
    default:
      return "var(--color-accent)";
  }
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: "6px 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
      {items.map((item, i) => (
        <li key={i} style={{ fontSize: 13, color: "var(--color-text)", lineHeight: 1.5 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function Kpis({ items }: { items: { label: string; value: string; tone?: AgentBlockTone }[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(items.length, 3)}, 1fr)`, gap: 10, margin: "8px 0" }}>
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "10px 12px",
            borderLeft: `3px solid ${toneColor(item.tone)}`,
          }}
        >
          <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {item.label}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--color-text)", marginTop: 2 }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function Table({ columns, rows }: { columns: string[]; rows: Array<Array<string | number>> }) {
  return (
    <div style={{ overflowX: "auto", margin: "8px 0", border: "1px solid var(--color-border)", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                style={{
                  textAlign: "left",
                  padding: "8px 12px",
                  fontSize: 10.5,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--color-text-muted)",
                  background: "var(--color-surface-2)",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ padding: "8px 12px", color: "var(--color-text)", borderTop: "1px solid var(--color-border)" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Recommendation({ block }: { block: Extract<AgentContentBlock, { type: "recommendation" }> }) {
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderLeft: `3px solid ${toneColor(block.tone)}`,
        borderRadius: 8,
        padding: 14,
        margin: "8px 0",
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--color-text)", fontFamily: "var(--font-heading)" }}>{block.title}</div>
      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 3, lineHeight: 1.5 }}>{block.description}</div>

      {block.stats && block.stats.length > 0 && (
        <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
          {block.stats.map((stat, i) => (
            <div key={i}>
              <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase" }}>{stat.label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text)" }}>{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {block.actions && block.actions.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {block.actions.map((action) =>
            action.to ? (
              <Link
                key={action.id}
                to={action.to}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "7px 12px",
                  borderRadius: 7,
                  textDecoration: "none",
                  background: action.kind === "primary" ? "var(--color-accent)" : "transparent",
                  color: action.kind === "primary" ? "var(--color-on-accent)" : "var(--color-text-secondary)",
                  border: action.kind === "primary" ? "none" : "1px solid var(--color-border)",
                }}
              >
                {action.label}
              </Link>
            ) : (
              <span
                key={action.id}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "7px 12px",
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--color-text-muted)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {action.label}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function ResponseRenderer({ blocks }: { blocks: AgentContentBlock[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "text":
            return (
              <p key={i} style={{ fontSize: 13, color: "var(--color-text)", lineHeight: 1.55, margin: "4px 0" }}>
                {block.text}
              </p>
            );
          case "bullets":
            return <Bullets key={i} items={block.items} />;
          case "kpis":
            return <Kpis key={i} items={block.items} />;
          case "table":
            return <Table key={i} columns={block.columns} rows={block.rows} />;
          case "recommendation":
            return <Recommendation key={i} block={block} />;
          case "link":
            return (
              <Link
                key={i}
                to={block.to}
                style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-accent)", textDecoration: "none", margin: "4px 0", display: "inline-block" }}
              >
                {block.label} →
              </Link>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
