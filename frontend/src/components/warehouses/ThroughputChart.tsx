import type { MonthBucket } from "../../lib/warehouseStats";

interface ThroughputChartProps {
  months: MonthBucket[];
}

const VB_WIDTH = 240;
const VB_HEIGHT = 108;
const PAD = 6;

export function ThroughputChart({ months }: ThroughputChartProps) {
  const max = Math.max(1, ...months.map((m) => m.total));
  const step = months.length > 1 ? (VB_WIDTH - PAD * 2) / (months.length - 1) : 0;

  const points = months.map((m, i) => {
    const x = PAD + i * step;
    const y = VB_HEIGHT - PAD - (m.total / max) * (VB_HEIGHT - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const linePoints = points.join(" ");
  const areaPoints = `${PAD},${VB_HEIGHT - PAD} ${linePoints} ${VB_WIDTH - PAD},${VB_HEIGHT - PAD}`;

  const total = months.reduce((sum, m) => sum + m.total, 0);
  const avg = months.length ? Math.round(total / months.length) : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22 }}>
          {total.toLocaleString()}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>avg {avg.toLocaleString()}/mo</div>
      </div>

      {total === 0 ? (
        <div
          style={{
            height: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12.5,
            color: "var(--color-text-muted)",
          }}
        >
          No stock movements in the last 12 months.
        </div>
      ) : (
        <svg viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`} style={{ width: "100%", height: 140 }}>
          <polygon points={areaPoints} fill="var(--color-accent)" opacity={0.14} />
          <polyline
            points={linePoints}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 9.5,
          color: "var(--color-text-muted)",
          paddingTop: 4,
        }}
      >
        {months.map((m, i) => (
          <span key={i}>{m.label}</span>
        ))}
      </div>
    </div>
  );
}
