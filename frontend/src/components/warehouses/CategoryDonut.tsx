import type { CategoryBreakdownEntry } from "../../lib/warehouseStats";

interface CategoryDonutProps {
  entries: CategoryBreakdownEntry[];
  totalUnits: number;
}

const SIZE = 140;
const STROKE = 16;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function CategoryDonut({ entries, totalUnits }: CategoryDonutProps) {
  const offsets: number[] = [];
  entries.reduce((acc, entry) => {
    offsets.push(acc);
    return acc + (entry.pct / 100) * CIRCUMFERENCE;
  }, 0);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <div style={{ width: SIZE, height: SIZE, flex: "none", position: "relative" }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--color-border)" strokeWidth={STROKE} />
          {entries.map((entry, i) => {
            const dash = (entry.pct / 100) * CIRCUMFERENCE;
            return (
              <circle
                key={entry.name}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={entry.color}
                strokeWidth={STROKE}
                strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                strokeDashoffset={-offsets[i]}
              />
            );
          })}
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22 }}>{totalUnits}</div>
          <div
            style={{
              fontSize: 9.5,
              color: "var(--color-text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Total Units
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 9 }}>
        {entries.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No inventory in this warehouse yet.</p>
        )}
        {entries.map((entry) => (
          <div key={entry.name}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span
                  style={{ width: 9, height: 9, borderRadius: 2, background: entry.color, display: "inline-block" }}
                />
                {entry.name}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
                {entry.pct}%
              </span>
            </div>
            <div style={{ height: 5, background: "var(--color-border)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${entry.pct}%`, height: "100%", background: entry.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
