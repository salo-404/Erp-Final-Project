import type { SupplierComparisonEntry } from "../../types/domain";

interface SupplierComparisonGridProps {
  suppliers: SupplierComparisonEntry[];
  compact?: boolean;
}

const RANK_COLORS = [
  { bg: "rgba(244,196,48,0.18)", color: "var(--color-warning)" },
  { bg: "rgba(168,176,192,0.18)", color: "var(--color-text-secondary)" },
  { bg: "rgba(205,127,50,0.18)", color: "#CD7F32" },
];

function onTimeRateColor(rate: number | null): string {
  if (rate === null) return "var(--color-text-muted)";
  if (rate >= 0.9) return "var(--color-success)";
  if (rate >= 0.7) return "var(--color-warning)";
  return "var(--color-danger)";
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function SupplierComparisonGrid({ suppliers, compact }: SupplierComparisonGridProps) {
  if (suppliers.length === 0) {
    return <p style={{ fontSize: 12.5, color: "var(--color-text-muted)", padding: "20px 22px" }}>No suppliers yet.</p>;
  }

  const sorted = [...suppliers].sort((a, b) => b.totalPurchaseCost - a.totalPurchaseCost);

  const ringSize = compact ? 42 : 56;
  const ringStroke = compact ? 5 : 6;
  const ringRadius = (ringSize - ringStroke) / 2;
  const ringCircumference = 2 * Math.PI * ringRadius;

  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? 210 : 260}px, 1fr))`, gap: compact ? 10 : 14, padding: compact ? 14 : 18 }}>
      {sorted.map((s, i) => {
        const rank = RANK_COLORS[i] ?? { bg: "var(--color-surface-2)", color: "var(--color-text-secondary)" };
        const rated = s.onTimeTransactions + s.lateTransactions;
        const onTimeRate = rated > 0 ? s.onTimeTransactions / rated : null;
        const ringColor = onTimeRateColor(onTimeRate);
        const dash = onTimeRate !== null ? onTimeRate * ringCircumference : 0;
        const totalTx = s.completedTransactions + s.cancelledTransactions;
        const cancelledPct = totalTx > 0 ? (s.cancelledTransactions / totalTx) * 100 : 0;

        return (
          <div
            key={s.supplierId}
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              borderRadius: 10,
              padding: compact ? 12 : 16,
              display: "flex",
              flexDirection: "column",
              gap: compact ? 9 : 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: compact ? 8 : 10 }}>
              <div
                style={{
                  width: compact ? 20 : 26,
                  height: compact ? 20 : 26,
                  flex: "none",
                  borderRadius: "50%",
                  background: rank.bg,
                  color: rank.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--font-heading)",
                  fontWeight: 800,
                  fontSize: compact ? 10.5 : 12,
                }}
              >
                {i + 1}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: compact ? 12 : 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.supplierName}</div>
                {!compact && (
                  <div style={{ fontSize: 10.5, color: "var(--color-text-muted)" }}>
                    {s.completedTransactions} completed{s.cancelledTransactions > 0 ? ` · ${s.cancelledTransactions} cancelled` : ""}
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: compact ? 10 : 16 }}>
              <div style={{ position: "relative", width: ringSize, height: ringSize, flex: "none" }}>
                <svg width={ringSize} height={ringSize} viewBox={`0 0 ${ringSize} ${ringSize}`} style={{ transform: "rotate(-90deg)" }}>
                  <circle cx={ringSize / 2} cy={ringSize / 2} r={ringRadius} fill="none" stroke="var(--color-border)" strokeWidth={ringStroke} />
                  {onTimeRate !== null && (
                    <circle
                      cx={ringSize / 2}
                      cy={ringSize / 2}
                      r={ringRadius}
                      fill="none"
                      stroke={ringColor}
                      strokeWidth={ringStroke}
                      strokeLinecap="round"
                      strokeDasharray={`${dash} ${ringCircumference - dash}`}
                    />
                  )}
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: compact ? 11 : 13, color: ringColor }}>
                    {onTimeRate !== null ? `${Math.round(onTimeRate * 100)}%` : "—"}
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: compact ? 9 : 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>Purchase Cost</div>
                <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: compact ? 14 : 18, marginBottom: compact ? 5 : 8 }}>{money(s.totalPurchaseCost)}</div>
                {!compact && (
                  <>
                    <div style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>Avg Unit Cost</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--color-text-secondary)" }}>{money(s.averageUnitCost)}</div>
                  </>
                )}
              </div>
            </div>

            {totalTx > 0 && (
              <div>
                <div style={{ height: compact ? 4 : 5, background: "var(--color-success)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
                  {cancelledPct > 0 && (
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${cancelledPct}%`, background: "var(--color-danger)" }} />
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
