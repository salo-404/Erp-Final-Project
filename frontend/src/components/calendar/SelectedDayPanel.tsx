import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { transactionStatusBadge } from "../../lib/transactionStatus";
import { friendlyErrorMessage } from "../../lib/friendlyError";
import { CalendarIcon } from "../ui/icons";
import type { DeliveryTransaction, Product } from "../../types/domain";

interface SelectedDayPanelProps {
  selectedDate: Date;
  deliveries: DeliveryTransaction[];
  productsById: Map<number, Product>;
  onCreateReminder: (transactionId: number) => Promise<void>;
}

function itemsSummary(d: DeliveryTransaction, productsById: Map<number, Product>): string {
  if (d.items.length === 0) return "No items";
  const first = productsById.get(d.items[0].productId)?.name ?? `Product #${d.items[0].productId}`;
  if (d.items.length === 1) return `${d.items[0].quantity} × ${first}`;
  return `${first} +${d.items.length - 1} more item${d.items.length - 1 > 1 ? "s" : ""}`;
}

function totalQty(d: DeliveryTransaction): number {
  return d.items.reduce((sum, it) => sum + it.quantity, 0);
}

export function SelectedDayPanel({ selectedDate, deliveries, productsById, onCreateReminder }: SelectedDayPanelProps) {
  const navigate = useNavigate();
  const [reminderState, setReminderState] = useState<Record<number, "idle" | "sending" | "done" | "error">>({});
  const [reminderError, setReminderError] = useState<Record<number, string>>({});

  async function handleReminder(id: number) {
    setReminderState((s) => ({ ...s, [id]: "sending" }));
    setReminderError((s) => ({ ...s, [id]: "" }));
    try {
      await onCreateReminder(id);
      setReminderState((s) => ({ ...s, [id]: "done" }));
    } catch (err) {
      setReminderState((s) => ({ ...s, [id]: "error" }));
      setReminderError((s) => ({ ...s, [id]: friendlyErrorMessage(err, "Failed to add reminder.") }));
    }
  }

  function goToRecord(d: DeliveryTransaction) {
    if (d.type === "INCOMING") navigate("/suppliers");
    else if (d.type === "OUTGOING") navigate("/orders");
    else navigate("/warehouses");
  }

  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 15.5 }}>
          {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 3 }}>{deliveries.length} scheduled {deliveries.length === 1 ? "delivery" : "deliveries"}</div>
      </div>

      {deliveries.length === 0 ? (
        <div style={{ textAlign: "center", padding: "36px 12px", color: "var(--color-text-muted)", background: "var(--color-surface-2)", border: "1px dashed var(--color-border)", borderRadius: 10 }}>
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--color-border)", color: "var(--color-text-muted)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
            <CalendarIcon className="h-5 w-5" />
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4, color: "var(--color-text)" }}>No deliveries scheduled</div>
          <div style={{ fontSize: 11 }}>Pick another date on the calendar</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {deliveries.map((d) => {
            const badge = transactionStatusBadge(d.status, d.expectedDate);
            const state = reminderState[d.id] ?? "idle";
            return (
              <div key={d.id} style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 12 }}>
                <div onClick={() => goToRecord(d)} style={{ cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{itemsSummary(d, productsById)}</div>
                      <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {d.type === "INCOMING" ? d.supplier?.name ?? "Unknown supplier" : d.partyName ?? "Unknown customer"}
                      </div>
                    </div>
                    <div style={{ fontSize: 9.5, fontWeight: 700, padding: "3px 8px", borderRadius: 5, background: badge.bg, color: badge.color, letterSpacing: "0.04em", flex: "none" }}>{badge.label}</div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--color-text-secondary)", paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>TXN-{d.id}</div>
                    <div>{totalQty(d)} units</div>
                    <div style={{ fontFamily: "var(--font-mono)" }}>{d.expectedDate ? new Date(d.expectedDate).toLocaleDateString() : "—"}</div>
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => handleReminder(d.id)}
                    disabled={state === "sending" || state === "done"}
                    title={state === "error" ? reminderError[d.id] : "Add to Google Calendar"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 10.5,
                      fontWeight: 600,
                      padding: "5px 9px",
                      borderRadius: 6,
                      background: state === "done" ? "rgba(34,197,94,0.12)" : "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      color: state === "done" ? "var(--color-success)" : state === "error" ? "var(--color-danger)" : "var(--color-text-secondary)",
                      cursor: state === "sending" || state === "done" ? "default" : "pointer",
                    }}
                  >
                    <CalendarIcon className="h-3 w-3" />
                    {state === "sending" ? "Adding..." : state === "done" ? "Added" : state === "error" ? "Failed — retry" : "Add reminder"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
