import type { TopProductEntry } from "../../lib/inventoryStats";

interface TopProductsCardProps {
  products: TopProductEntry[];
}

// Ranked by current on-hand stock — always populated as long as there's
// inventory, unlike a recent-movement ranking which goes empty on quiet
// warehouses.
export function TopProductsCard({ products }: TopProductsCardProps) {
  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Top Products</div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>by units on hand</div>
      </div>

      {products.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--color-text-muted)", textAlign: "center", padding: "20px 0" }}>
          No stock in this warehouse yet.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, justifyContent: "center" }}>
          {products.map((p) => (
            <div key={p.productId}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                <span style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {p.name}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", fontWeight: 600, flexShrink: 0, marginLeft: 8 }}>
                  {p.onHand.toLocaleString()}
                </span>
              </div>
              <div style={{ height: 7, background: "var(--color-border)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${p.pct}%`, height: "100%", background: "var(--color-accent)", borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
