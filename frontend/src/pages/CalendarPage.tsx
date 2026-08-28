import { useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../lib/useFetch";
import { listProducts } from "../lib/products.api";
import { getOverdueDeliveries, getUpcomingDeliveries } from "../lib/deliveries.api";
import { createShipmentReminder, getGoogleCalendarEvents, sendEmail } from "../lib/googleIntegrations.api";
import {
  buildMonthGrid,
  buildReminderEmailBody,
  countDeliveries,
  deliveryKeyForDate,
  filterDeliveries,
  groupDeliveriesByDay,
  monthLabel,
  type DeliveryFilter,
} from "../lib/calendarStats";
import { CalendarGrid } from "../components/calendar/CalendarGrid";
import { SelectedDayPanel } from "../components/calendar/SelectedDayPanel";
import { EmailNotificationsCard, type ConnectionStatus } from "../components/calendar/EmailNotificationsCard";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "../components/ui/icons";
import type { DeliveryTransaction, Product } from "../types/domain";

const FILTER_TABS: { value: DeliveryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "overdue", label: "Overdue" },
];

function todayIso(): string {
  return new Date().toISOString();
}
function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export function CalendarPage() {
  const { user } = useAuth();
  const now = new Date();

  const upcomingFetch = useFetch(() => getUpcomingDeliveries(365), []);
  const overdueFetch = useFetch(() => getOverdueDeliveries(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);
  const calendarProbe = useFetch(() => getGoogleCalendarEvents(todayIso(), tomorrowIso()), []);

  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [selectedKey, setSelectedKey] = useState(deliveryKeyForDate(now));
  const [filter, setFilter] = useState<DeliveryFilter>("all");

  const allDeliveries: DeliveryTransaction[] = useMemo(
    () => [...(upcomingFetch.data ?? []), ...(overdueFetch.data ?? [])],
    [upcomingFetch.data, overdueFetch.data],
  );
  const products = useMemo(() => productsFetch.data ?? [], [productsFetch.data]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const counts = useMemo(() => countDeliveries(allDeliveries), [allDeliveries]);
  const filteredDeliveries = useMemo(() => filterDeliveries(allDeliveries, filter), [allDeliveries, filter]);
  const deliveriesByDay = useMemo(() => groupDeliveriesByDay(filteredDeliveries), [filteredDeliveries]);

  const cells = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  const selectedDate = useMemo(() => {
    const [y, m, d] = selectedKey.split("-").map(Number);
    return new Date(y, m - 1, d);
  }, [selectedKey]);
  const selectedDeliveries = deliveriesByDay.get(selectedKey) ?? [];

  function goPrevMonth() {
    const d = new Date(viewYear, viewMonth - 1, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  }
  function goNextMonth() {
    const d = new Date(viewYear, viewMonth + 1, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  }
  function goToday() {
    const t = new Date();
    setViewYear(t.getFullYear());
    setViewMonth(t.getMonth());
    setSelectedKey(deliveryKeyForDate(t));
  }

  function partyLabel(d: DeliveryTransaction): string {
    return d.type === "INCOMING" ? d.supplier?.name ?? "Supplier" : d.partyName ?? "Customer";
  }

  async function handleCreateReminder(transactionId: number) {
    await createShipmentReminder(transactionId);
  }

  async function handleSendBucketReminder(bucket: "today" | "upcoming" | "overdue") {
    if (!user) throw new Error("Not signed in.");
    const bucketDeliveries = filterDeliveries(allDeliveries, bucket);
    const subject = `Nexora ERP — ${bucket[0].toUpperCase()}${bucket.slice(1)} deliveries (${bucketDeliveries.length})`;
    const body = buildReminderEmailBody(bucket, bucketDeliveries, productsById);
    await sendEmail(user.email, subject, body);
  }

  const connectionStatus: ConnectionStatus = calendarProbe.loading ? "checking" : calendarProbe.error ? "disconnected" : "connected";

  const isLoading = upcomingFetch.loading || overdueFetch.loading || productsFetch.loading;
  const loadError = upcomingFetch.error || overdueFetch.error || productsFetch.error;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading calendar..." />
      </div>
    );
  }
  if (loadError) {
    return (
      <ErrorMessage
        message={loadError}
        onRetry={() => {
          upcomingFetch.refetch();
          overdueFetch.refetch();
          productsFetch.refetch();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Nav + filters + sync */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 4 }}>
            <button type="button" onClick={goPrevMonth} style={{ width: 32, height: 32, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--color-text-secondary)", background: "none", border: "none" }}>
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 14.5, padding: "0 14px", minWidth: 160, textAlign: "center" }}>{monthLabel(viewYear, viewMonth)}</div>
            <button type="button" onClick={goNextMonth} style={{ width: 32, height: 32, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--color-text-secondary)", background: "none", border: "none" }}>
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
          <button type="button" onClick={goToday} style={{ fontSize: 12, fontWeight: 600, padding: "9px 14px", borderRadius: 8, background: "var(--color-surface)", border: "1px solid var(--color-border)", cursor: "pointer", color: "var(--color-text-secondary)" }}>
            Today
          </button>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {FILTER_TABS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "8px 13px",
                  borderRadius: 8,
                  border: "1px solid var(--color-border)",
                  background: filter === f.value ? "var(--color-accent)" : "var(--color-surface)",
                  color: filter === f.value ? "var(--color-on-accent)" : "var(--color-text-secondary)",
                  cursor: "pointer",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => calendarProbe.refetch()}
          disabled={calendarProbe.loading}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, padding: "10px 14px", borderRadius: 8, background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)", cursor: calendarProbe.loading ? "default" : "pointer", opacity: calendarProbe.loading ? 0.7 : 1 }}
        >
          <CalendarIcon className="h-[14px] w-[14px]" />
          {calendarProbe.loading ? "Syncing..." : "Sync with Google Calendar"}
        </button>
      </div>

      {calendarProbe.error && (
        <ErrorMessage message="Google Calendar isn't connected on this backend (no OAuth credentials configured) — showing real ERP delivery data only." />
      )}

      {/* Status summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        {[
          { label: "Today", count: counts.today, color: "var(--color-warning)", bg: "rgba(244,196,48,0.16)" },
          { label: "Upcoming", count: counts.upcoming, color: "var(--color-accent)", bg: "var(--color-accent-tint)" },
          { label: "Overdue", count: counts.overdue, color: "var(--color-danger)", bg: "rgba(239,68,68,0.14)" },
          { label: "Total Scheduled", count: counts.total, color: "var(--color-text-secondary)", bg: "var(--color-surface-2)" },
        ].map((s) => (
          <div key={s.label} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderLeft: `3px solid ${s.color}`, borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: s.bg, color: s.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15 }}>{s.count}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{s.label}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>deliveries</div>
            </div>
          </div>
        ))}
      </div>

      {/* Calendar + selected day */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
        <div style={{ flex: "2 1 480px", minWidth: 0 }}>
          <CalendarGrid cells={cells} deliveriesByDay={deliveriesByDay} selectedKey={selectedKey} onSelectDay={setSelectedKey} partyLabel={partyLabel} />
        </div>
        <div style={{ flex: "1 1 300px", minWidth: 0 }}>
          <SelectedDayPanel selectedDate={selectedDate} deliveries={selectedDeliveries} productsById={productsById} onCreateReminder={handleCreateReminder} />
        </div>
      </div>

      <EmailNotificationsCard
        counts={counts}
        connectionStatus={connectionStatus}
        onSendBucketReminder={handleSendBucketReminder}
      />
    </div>
  );
}
