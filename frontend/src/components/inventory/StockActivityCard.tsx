export interface ActivityMetric {
  label: string;
  value: number;
  sub: string;
  color: string;
}

interface StockActivityCardProps {
  metrics: ActivityMetric[];
}

// A single comparison bar chart across all 3 metrics, instead of a per-metric
// 7-day trend — the trend approach looked broken on warehouses with sparse
// recent history (mostly-empty day cells). A relative comparison always
// reads as intentional, even when the values themselves are small or zero.
export function StockActivityCard({ metrics }: StockActivityCardProps) {
  const max = Math.max(1, ...metrics.map((m) => m.value));

  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Stock Activity</div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>Reserved → In The Way → Arrived</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 12, marginBottom: 20 }}>
        {metrics.map((m) => (
          <div
            key={m.label}
            style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "12px 12px" }}
          >
            <div style={{ fontSize: 10.5, color: "var(--color-text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              {m.label}
            </div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22, lineHeight: 1, color: m.color }}>
              {m.value.toLocaleString()}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", marginTop: 4 }}>{m.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, justifyContent: "flex-end" }}>
        {metrics.map((m) => (
          <div key={m.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 5 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--color-text-secondary)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: m.color, display: "inline-block" }} />
                {m.label}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", fontWeight: 600 }}>{m.value}</span>
            </div>
            <div style={{ height: 8, background: "var(--color-border)", borderRadius: 4, overflow: "hidden" }}>
              <div
                style={{
                  width: `${(m.value / max) * 100}%`,
                  height: "100%",
                  background: m.color,
                  borderRadius: 4,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
