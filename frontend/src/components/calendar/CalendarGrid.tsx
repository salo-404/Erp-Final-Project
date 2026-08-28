import { WEEKDAY_LABELS, type MonthCell } from "../../lib/calendarStats";
import { transactionStatusBadge } from "../../lib/transactionStatus";
import type { DeliveryTransaction } from "../../types/domain";

interface CalendarGridProps {
  cells: MonthCell[];
  deliveriesByDay: Map<string, DeliveryTransaction[]>;
  selectedKey: string;
  onSelectDay: (key: string) => void;
  partyLabel: (d: DeliveryTransaction) => string;
}

const MAX_CHIPS = 2;

export function CalendarGrid({ cells, deliveriesByDay, selectedKey, onSelectDay, partyLabel }: CalendarGridProps) {
  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginBottom: 10 }}>
        {WEEKDAY_LABELS.map((wd) => (
          <div key={wd} style={{ fontFamily: "var(--font-heading)", fontSize: 10.5, fontWeight: 700, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", textAlign: "center", padding: "4px 0" }}>
            {wd}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gridAutoRows: 84, gap: 8 }}>
        {cells.map((cell) => {
          const deliveries = deliveriesByDay.get(cell.key) ?? [];
          const shown = deliveries.slice(0, MAX_CHIPS);
          const extra = deliveries.length - shown.length;
          const isSelected = cell.key === selectedKey;

          return (
            <div
              key={cell.key}
              onClick={() => onSelectDay(cell.key)}
              style={{
                height: 84,
                borderRadius: 8,
                padding: "6px 6px 8px",
                cursor: "pointer",
                background: isSelected ? "var(--color-surface-2)" : "transparent",
                border: isSelected ? "1px solid var(--color-accent)" : "1px solid transparent",
                opacity: cell.inMonth ? 1 : 0.4,
                display: "flex",
                flexDirection: "column",
                gap: 5,
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11.5,
                    fontWeight: cell.isToday ? 800 : 500,
                    fontFamily: "var(--font-heading)",
                    background: cell.isToday ? "var(--color-accent)" : "transparent",
                    color: cell.isToday ? "var(--color-on-accent)" : "var(--color-text)",
                  }}
                >
                  {cell.day}
                </div>
                {deliveries.length > 0 && <div style={{ fontSize: 9.5, color: "var(--color-text-muted)", fontWeight: 600 }}>{deliveries.length}</div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {shown.map((d) => {
                  const badge = transactionStatusBadge(d.status, d.expectedDate);
                  return (
                    <div
                      key={d.id}
                      style={{ fontSize: 9.5, fontWeight: 600, padding: "2px 5px", borderRadius: 4, background: badge.bg, color: badge.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {partyLabel(d)}
                    </div>
                  );
                })}
                {extra > 0 && <div style={{ fontSize: 9.5, color: "var(--color-accent)", fontWeight: 600, paddingLeft: 2 }}>+{extra} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
