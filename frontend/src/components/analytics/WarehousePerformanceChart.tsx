import type { WarehouseDemand } from "../../types/domain";

interface WarehousePerformanceChartProps {
  warehouses: WarehouseDemand[];
  compact?: boolean;
}

const RANK_COLORS = [
  { bg: "rgba(244,196,48,0.18)", color: "var(--color-warning)" }, // 1st
  { bg: "rgba(168,176,192,0.18)", color: "var(--color-text-secondary)" }, // 2nd
  { bg: "rgba(205,127,50,0.18)", color: "#CD7F32" }, // 3rd
];

export function WarehousePerformanceChart({ warehouses, compact }: WarehousePerformanceChartProps) {
  if (warehouses.length === 0) {
    return <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No completed sales yet.</p>;
  }

  const max = Math.max(1, ...warehouses.map((w) => w.totalQuantitySold));
  const total = warehouses.reduce((sum, w) => sum + w.totalQuantitySold, 0);
  const rankSize = compact ? 22 : 30;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 9 : 14 }}>
      {warehouses.map((w, i) => {
        const rank = RANK_COLORS[i] ?? { bg: "var(--color-surface-2)", color: "var(--color-text-secondary)" };
        const pct = total > 0 ? Math.round((w.totalQuantitySold / total) * 100) : 0;
        const barPct = (w.totalQuantitySold / max) * 100;
        return (
          <div key={w.warehouseId} style={{ display: "flex", alignItems: "center", gap: compact ? 10 : 14 }}>
            <div
              style={{
                width: rankSize,
                height: rankSize,
                flex: "none",
                borderRadius: "50%",
                background: rank.bg,
                color: rank.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--font-heading)",
                fontWeight: 800,
                fontSize: compact ? 11 : 13,
              }}
            >
              {i + 1}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: compact ? 4 : 6, gap: 10 }}>
                <span style={{ fontSize: compact ? 12 : 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.warehouseName}</span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: compact ? 12.5 : 14, fontWeight: 700 }}>{w.totalQuantitySold.toLocaleString()}</span>
                  {!compact && <span style={{ fontSize: 10.5, color: "var(--color-text-muted)" }}>units · {w.orderCount} orders</span>}
                </span>
              </div>
              <div style={{ position: "relative", height: compact ? 6 : 8, background: "var(--color-border)", borderRadius: 5, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${barPct}%`,
                    height: "100%",
                    borderRadius: 5,
                    background: `linear-gradient(90deg, var(--color-accent) 0%, ${rank.color} 100%)`,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
            <div style={{ flex: "none", width: compact ? 30 : 38, textAlign: "right", fontSize: compact ? 10 : 11, fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>{pct}%</div>
          </div>
        );
      })}
    </div>
  );
}
