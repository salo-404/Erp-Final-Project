import { useState } from "react";
import type { MergedTrendPoint } from "../../lib/analyticsStats";

interface RevenueTrendChartProps {
  points: MergedTrendPoint[];
}

const VB_WIDTH = 720;
const VB_HEIGHT = 260;
const PAD_LEFT = 52;
const PAD_RIGHT = 12;
const PAD_TOP = 14;
const PAD_BOTTOM = 30;
const GRID_LINES = 4;

function formatShort(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Rounded-top-only bar, so paired bars read as a single cohesive shape
// rather than two flat-topped rectangles.
function roundedTopRectPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height);
  if (height <= 0) return "";
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}

export function RevenueTrendChart({ points }: RevenueTrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>
        No sales or purchase data in this range.
      </div>
    );
  }

  const max = Math.max(1, ...points.map((p) => p.revenue), ...points.map((p) => p.purchaseCost));
  const plotWidth = VB_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = VB_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const groupWidth = plotWidth / points.length;
  const barWidth = Math.min(16, groupWidth * 0.32);

  const gridValues = Array.from({ length: GRID_LINES + 1 }, (_, i) => (max / GRID_LINES) * i);
  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoverLeftPct = hoverIndex !== null ? ((PAD_LEFT + hoverIndex * groupWidth + groupWidth / 2) / VB_WIDTH) * 100 : 0;

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--color-text-secondary)" }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-success)", display: "inline-block" }} />
          Revenue
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--color-text-secondary)" }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-danger)", display: "inline-block" }} />
          Purchase Cost
        </div>
      </div>

      {hovered && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: `${hoverLeftPct}%`,
            transform: "translate(-50%, -100%)",
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "8px 11px",
            fontSize: 11.5,
            whiteSpace: "nowrap",
            boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{formatDate(hovered.date)}</div>
          <div style={{ color: "var(--color-success)" }}>Revenue: {formatShort(hovered.revenue)}</div>
          <div style={{ color: "var(--color-danger)" }}>Cost: {formatShort(hovered.purchaseCost)}</div>
        </div>
      )}

      <svg viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`} style={{ width: "100%", height: 260, overflow: "visible" }}>
        <defs>
          <linearGradient id="revenueBarGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-success)" stopOpacity={1} />
            <stop offset="100%" stopColor="var(--color-success)" stopOpacity={0.55} />
          </linearGradient>
          <linearGradient id="costBarGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-danger)" stopOpacity={1} />
            <stop offset="100%" stopColor="var(--color-danger)" stopOpacity={0.55} />
          </linearGradient>
        </defs>

        {/* Gridlines + y-axis labels */}
        {gridValues.map((v, i) => {
          const y = PAD_TOP + plotHeight - (v / max) * plotHeight;
          return (
            <g key={i}>
              <line x1={PAD_LEFT} y1={y} x2={VB_WIDTH - PAD_RIGHT} y2={y} stroke="var(--color-border)" strokeWidth={1} />
              <text x={PAD_LEFT - 8} y={y + 3} textAnchor="end" fontSize={9.5} fill="var(--color-text-muted)">{formatShort(v)}</text>
            </g>
          );
        })}

        {/* Bars + hover targets */}
        {points.map((p, i) => {
          const groupX = PAD_LEFT + i * groupWidth;
          const revHeight = (p.revenue / max) * plotHeight;
          const costHeight = (p.purchaseCost / max) * plotHeight;
          const revX = groupX + groupWidth / 2 - barWidth - 1.5;
          const costX = groupX + groupWidth / 2 + 1.5;

          return (
            <g
              key={i}
              onMouseEnter={() => setHoverIndex(i)}
              onMouseLeave={() => setHoverIndex(null)}
              style={{ cursor: "pointer" }}
            >
              <rect x={groupX} y={PAD_TOP} width={groupWidth} height={plotHeight} fill="transparent" />
              {p.revenue > 0 && (
                <path d={roundedTopRectPath(revX, PAD_TOP + plotHeight - revHeight, barWidth, revHeight, 3)} fill="url(#revenueBarGradient)" opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.45} />
              )}
              {p.purchaseCost > 0 && (
                <path d={roundedTopRectPath(costX, PAD_TOP + plotHeight - costHeight, barWidth, costHeight, 3)} fill="url(#costBarGradient)" opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.45} />
              )}
              {hoverIndex === i && (
                <line x1={groupX + groupWidth / 2} y1={PAD_TOP} x2={groupX + groupWidth / 2} y2={PAD_TOP + plotHeight} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3,3" opacity={0.5} />
              )}
              {i % labelStep === 0 && (
                <text x={groupX + groupWidth / 2} y={VB_HEIGHT - PAD_BOTTOM + 16} textAnchor="middle" fontSize={9.5} fill="var(--color-text-muted)">
                  {formatDate(p.date)}
                </text>
              )}
            </g>
          );
        })}

        <line x1={PAD_LEFT} y1={PAD_TOP + plotHeight} x2={VB_WIDTH - PAD_RIGHT} y2={PAD_TOP + plotHeight} stroke="var(--color-border)" strokeWidth={1.5} />
      </svg>
    </div>
  );
}
