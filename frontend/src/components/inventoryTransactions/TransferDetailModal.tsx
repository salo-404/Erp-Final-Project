import { Modal } from "../ui/Modal";
import { transactionStatusBadge } from "../../lib/transactionStatus";
import type { InventoryTransactionWithItems } from "../../types/domain";

interface TransferDetailModalProps {
  transfer: InventoryTransactionWithItems;
  sourceWarehouseName: string;
  destinationWarehouseName: string;
  productName: (productId: number) => string;
  onClose: () => void;
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 };

export function TransferDetailModal({ transfer, sourceWarehouseName, destinationWarehouseName, productName, onClose }: TransferDetailModalProps) {
  const badge = transactionStatusBadge(transfer.status, transfer.expectedDate);

  return (
    <Modal title={`Transfer TXN-${transfer.id}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>From</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{sourceWarehouseName}</div>
          </div>
          <div style={{ fontSize: 18, color: "var(--color-text-muted)" }}>→</div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>To</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{destinationWarehouseName}</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 24 }}>
          <div>
            <div style={labelStyle}>Expected</div>
            <div style={{ fontSize: 13 }}>{transfer.expectedDate ? new Date(transfer.expectedDate).toLocaleDateString() : "—"}</div>
          </div>
          <div>
            <div style={labelStyle}>Arrived</div>
            <div style={{ fontSize: 13 }}>{transfer.actualDate ? new Date(transfer.actualDate).toLocaleDateString() : "—"}</div>
          </div>
        </div>

        <div>
          <div style={{ ...labelStyle, marginBottom: 8 }}>Products transferred</div>
          <div style={{ border: "1px solid var(--color-border)", borderRadius: 8, overflow: "hidden" }}>
            {transfer.items.map((item, i) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  fontSize: 13,
                  borderTop: i > 0 ? "1px solid var(--color-border)" : "none",
                }}
              >
                <span>{productName(item.productId)}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{item.quantity}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
