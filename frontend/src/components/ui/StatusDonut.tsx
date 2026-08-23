export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface StatusDonutProps {
  segments: DonutSegment[];
  centerLabel: string;
}

const SIZE = 140;
const STROKE = 16;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function StatusDonut({ segments, centerLabel }: StatusDonutProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const offsets: number[] = [];
  segments.reduce((acc, s) => {
    offsets.push(acc);
    return acc + (total === 0 ? 0 : (s.value / total) * CIRCUMFERENCE);
  }, 0);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <div style={{ width: SIZE, height: SIZE, flex: "none", position: "relative" }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--color-border)" strokeWidth={STROKE} />
          {total > 0 &&
            segments.map((s, i) => {
              const dash = (s.value / total) * CIRCUMFERENCE;
              if (dash <= 0) return null;
              return (
                <circle
                  key={s.label}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={STROKE}
                  strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                  strokeDashoffset={-offsets[i]}
                />
              );
            })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 26 }}>{total}</div>
          <div style={{ fontSize: 9.5, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>{centerLabel}</div>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
        {segments.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)" }}>{s.label}</div>
              <div style={{ fontSize: 9.5, color: "var(--color-text-muted)" }}>
                {total > 0 ? Math.round((s.value / total) * 100) : 0}% of total
              </div>
            </div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 16 }}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
