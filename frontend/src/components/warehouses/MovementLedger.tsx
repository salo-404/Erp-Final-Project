import { useMemo, useState } from "react";
import type { InventoryTransactionSummary, StockMovement, StockMovementType } from "../../types/domain";
import { ShowMoreRow } from "../ui/ShowMoreRow";
import { useShowMore } from "../../lib/useShowMore";

interface MovementLedgerProps {
  movements: StockMovement[];
  productNames: Map<number, string>;
  warehouseNames: Map<number, string>;
  transfers: InventoryTransactionSummary[];
  currentWarehouseId: number;
}

type FilterKey = "all" | "INCOMING" | "OUTGOING" | "TRANSFER" | "ADJUSTMENT";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "INCOMING", label: "Incoming" },
  { key: "OUTGOING", label: "Outgoing" },
  { key: "TRANSFER", label: "Transfers" },
  { key: "ADJUSTMENT", label: "Adjustments" },
];

const TYPE_STYLE: Record<StockMovementType, { label: string; bg: string; color: string }> = {
  INCOMING: { label: "INCOMING", bg: "rgba(34,197,94,0.14)", color: "var(--color-success)" },
  TRANSFER_IN: { label: "TRANSFER IN", bg: "rgba(34,197,94,0.14)", color: "var(--color-success)" },
  OUTGOING: { label: "OUTGOING", bg: "rgba(239,68,68,0.14)", color: "var(--color-danger)" },
  TRANSFER_OUT: { label: "TRANSFER OUT", bg: "rgba(239,68,68,0.14)", color: "var(--color-danger)" },
  ADJUSTMENT: { label: "ADJUSTMENT", bg: "rgba(244,196,48,0.16)", color: "var(--color-warning)" },
};

function matchesFilter(type: StockMovementType, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "TRANSFER") return type === "TRANSFER_IN" || type === "TRANSFER_OUT";
  return type === filter;
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 16px",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--color-text-muted)",
};
const tdStyle: React.CSSProperties = {
  padding: "10px 16px",
  fontSize: 13,
  borderTop: "1px solid var(--color-border)",
};

export function MovementLedger({
  movements,
  productNames,
  warehouseNames,
  transfers,
  currentWarehouseId,
}: MovementLedgerProps) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const transferById = useMemo(() => new Map(transfers.map((t) => [t.id, t])), [transfers]);

  const filtered = movements.filter((m) => matchesFilter(m.type, filter));
  const showMore = useShowMore(filtered, 10, 10);

  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 20px",
          borderBottom: "1px solid var(--color-border)",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Stock Movement Ledger</div>
          <div style={{ display: "flex", gap: 6 }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: 7,
                  border: "1px solid var(--color-border)",
                  background: filter === f.key ? "var(--color-accent)" : "transparent",
                  color: filter === f.key ? "var(--color-on-accent)" : "var(--color-text-secondary)",
                  cursor: "pointer",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{filtered.length} movements</div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: "36px 20px", textAlign: "center", color: "var(--color-text-muted)", fontSize: 12.5 }}>
          No movements match this filter.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr style={{ background: "var(--color-surface-2)" }}>
                <th style={thStyle}>Date &amp; Time</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Product</th>
                <th style={thStyle}>Reference</th>
                <th style={thStyle}>Related</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Qty</th>
              </tr>
            </thead>
            <tbody>
              {showMore.visible.map((m) => {
                const style = TYPE_STYLE[m.type];
                const isIncrease = m.type === "INCOMING" || m.type === "TRANSFER_IN" || (m.type === "ADJUSTMENT" && m.quantity > 0);
                const qtyLabel = m.type === "ADJUSTMENT" ? (m.quantity > 0 ? `+${m.quantity}` : `${m.quantity}`) : isIncrease ? `+${m.quantity}` : `-${m.quantity}`;

                let related = "—";
                if ((m.type === "TRANSFER_IN" || m.type === "TRANSFER_OUT") && m.transactionId) {
                  const tx = transferById.get(m.transactionId);
                  if (tx) {
                    const counterpartId = m.type === "TRANSFER_OUT" ? tx.destinationWarehouseId : tx.sourceWarehouseId;
                    if (counterpartId && counterpartId !== currentWarehouseId) {
                      related = warehouseNames.get(counterpartId) ?? `Warehouse #${counterpartId}`;
                    }
                  }
                }

                return (
                  <tr key={m.id}>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                      {new Date(m.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "3px 9px",
                          borderRadius: 4,
                          background: style.bg,
                          color: style.color,
                          letterSpacing: "0.06em",
                        }}
                      >
                        {style.label}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>{productNames.get(m.productId) ?? `Product #${m.productId}`}</td>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-secondary)" }}>
                      {m.transactionId ? `TXN-${m.transactionId}` : "—"}
                    </td>
                    <td style={{ ...tdStyle, fontSize: 12.5, color: "var(--color-text-secondary)" }}>{related}</td>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "var(--font-mono)",
                        fontWeight: 700,
                        textAlign: "right",
                        color: qtyLabel.startsWith("-") ? "var(--color-danger)" : "var(--color-success)",
                      }}
                    >
                      {qtyLabel}
                    </td>
                  </tr>
                );
              })}
              <ShowMoreRow colSpan={6} shown={showMore.shown} total={showMore.total} canShowLess={showMore.canShowLess} onShowMore={showMore.showMore} onShowLess={showMore.showLess} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
