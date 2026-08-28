import { useState } from "react";
import { MailIcon } from "../ui/icons";
import { ErrorMessage } from "../ui/ErrorMessage";
import { friendlyErrorMessage } from "../../lib/friendlyError";
import type { DeliveryCounts } from "../../lib/calendarStats";

export type ConnectionStatus = "checking" | "connected" | "disconnected";

interface EmailNotificationsCardProps {
  counts: DeliveryCounts;
  connectionStatus: ConnectionStatus;
  onSendBucketReminder: (bucket: "today" | "upcoming" | "overdue") => Promise<void>;
}

const BUCKET_CARDS: { bucket: "today" | "upcoming" | "overdue"; tag: string; tagBg: string; tagColor: string; label: string }[] = [
  { bucket: "today", tag: "TODAY", tagBg: "rgba(244,196,48,0.16)", tagColor: "var(--color-warning)", label: "Deliveries due today" },
  { bucket: "upcoming", tag: "UPCOMING", tagBg: "var(--color-accent-tint)", tagColor: "var(--color-accent)", label: "Deliveries on the way" },
  { bucket: "overdue", tag: "OVERDUE", tagBg: "rgba(239,68,68,0.14)", tagColor: "var(--color-danger)", label: "Deliveries past due" },
];

export function EmailNotificationsCard({ counts, connectionStatus, onSendBucketReminder }: EmailNotificationsCardProps) {
  const [bucketState, setBucketState] = useState<Record<string, "idle" | "sending" | "done" | "error">>({});
  const [bucketError, setBucketError] = useState<Record<string, string>>({});

  async function handleBucket(bucket: "today" | "upcoming" | "overdue") {
    setBucketState((s) => ({ ...s, [bucket]: "sending" }));
    setBucketError((s) => ({ ...s, [bucket]: "" }));
    try {
      await onSendBucketReminder(bucket);
      setBucketState((s) => ({ ...s, [bucket]: "done" }));
    } catch (err) {
      setBucketState((s) => ({ ...s, [bucket]: "error" }));
      setBucketError((s) => ({ ...s, [bucket]: friendlyErrorMessage(err, "Failed to send.") }));
    }
  }

  const statusDot = connectionStatus === "connected" ? "var(--color-success)" : connectionStatus === "checking" ? "var(--color-text-muted)" : "var(--color-danger)";
  const statusLabel = connectionStatus === "connected" ? "Connected" : connectionStatus === "checking" ? "Checking connection..." : "Not connected";

  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: "var(--color-surface-2)", color: "var(--color-accent)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
            <MailIcon className="h-[18px] w-[18px]" />
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Email Notifications</div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 3 }}>Real delivery reminders, sent via Gmail</div>
          </div>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--color-text-secondary)", background: "var(--color-surface-2)", border: "1px solid var(--color-border)", padding: "6px 12px", borderRadius: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: statusDot }} />
          {statusLabel}
        </div>
      </div>

      {connectionStatus === "disconnected" && (
        <div style={{ marginBottom: 16 }}>
          <ErrorMessage message="Google Calendar/Gmail isn't connected on this backend (no OAuth credentials configured) — reminders below will fail until credentials/google-oauth.json and google-token.json are set up." />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {BUCKET_CARDS.map((c) => {
          const count = counts[c.bucket];
          const state = bucketState[c.bucket] ?? "idle";
          return (
            <div key={c.bucket} style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 }}>
                <span style={{ fontSize: 9.5, fontWeight: 800, padding: "3px 8px", borderRadius: 5, background: c.tagBg, color: c.tagColor, letterSpacing: "0.06em" }}>{c.tag}</span>
                <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 16, color: c.tagColor }}>{count}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{c.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", lineHeight: 1.5, marginBottom: 12 }}>
                {count === 0 ? "Nothing in this bucket right now." : `${count} real ${count === 1 ? "transaction" : "transactions"} from the ERP.`}
              </div>
              <button
                type="button"
                onClick={() => handleBucket(c.bucket)}
                disabled={count === 0 || state === "sending" || state === "done"}
                title={state === "error" ? bucketError[c.bucket] : undefined}
                style={{
                  width: "100%",
                  fontSize: 11.5,
                  fontWeight: 600,
                  padding: "8px 10px",
                  borderRadius: 7,
                  border: "1px solid var(--color-border)",
                  background: state === "done" ? "rgba(34,197,94,0.12)" : "var(--color-surface)",
                  color: state === "done" ? "var(--color-success)" : state === "error" ? "var(--color-danger)" : "var(--color-text-secondary)",
                  cursor: count === 0 || state === "sending" || state === "done" ? "default" : "pointer",
                  opacity: count === 0 ? 0.5 : 1,
                }}
              >
                {state === "sending" ? "Sending..." : state === "done" ? "Sent to you" : state === "error" ? "Failed — retry" : "Email me this list"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
