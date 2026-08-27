import type { DeliveryTransaction, Product } from "../types/domain";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface MonthCell {
  date: Date;
  key: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

// Local, not UTC - the calendar grid itself is built entirely from local
// Date arithmetic (buildMonthGrid below), so comparing it against a UTC
// day would drift by one day for roughly half of every 24 hours in any
// negative-UTC-offset timezone (e.g. late evening local time is already
// "tomorrow" in UTC) - a real, confirmed bug where "today" landed on the
// wrong grid cell.
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Always a 6x7 grid (42 cells) so the calendar's height never jumps between months. */
export function buildMonthGrid(year: number, month: number): MonthCell[] {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startOffset);
  const today = dateKey(new Date());

  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const key = dateKey(date);
    return { date, key, day: date.getDate(), inMonth: date.getMonth() === month, isToday: key === today };
  });
}

export type DeliveryBucket = "today" | "upcoming" | "overdue";

export function deliveryBucket(expectedDate: string, referenceDate: Date = new Date()): DeliveryBucket {
  const today = dateKey(referenceDate);
  const key = dateKey(new Date(expectedDate));
  if (key === today) return "today";
  if (key < today) return "overdue";
  return "upcoming";
}

export type DeliveryFilter = "all" | DeliveryBucket;

export function filterDeliveries(deliveries: DeliveryTransaction[], filter: DeliveryFilter, referenceDate: Date = new Date()): DeliveryTransaction[] {
  if (filter === "all") return deliveries;
  return deliveries.filter((d) => d.expectedDate && deliveryBucket(d.expectedDate, referenceDate) === filter);
}

/** Groups by UTC calendar day (YYYY-MM-DD) — only transactions with a real expectedDate participate. */
export function groupDeliveriesByDay(deliveries: DeliveryTransaction[]): Map<string, DeliveryTransaction[]> {
  const map = new Map<string, DeliveryTransaction[]>();
  for (const d of deliveries) {
    if (!d.expectedDate) continue;
    const key = dateKey(new Date(d.expectedDate));
    const existing = map.get(key);
    if (existing) existing.push(d);
    else map.set(key, [d]);
  }
  return map;
}

export function deliveryKeyForDate(d: Date): string {
  return dateKey(d);
}

export interface DeliveryCounts {
  today: number;
  upcoming: number;
  overdue: number;
  total: number;
}

export function countDeliveries(deliveries: DeliveryTransaction[], referenceDate: Date = new Date()): DeliveryCounts {
  let today = 0;
  let upcoming = 0;
  let overdue = 0;
  for (const d of deliveries) {
    if (!d.expectedDate) continue;
    const bucket = deliveryBucket(d.expectedDate, referenceDate);
    if (bucket === "today") today++;
    else if (bucket === "upcoming") upcoming++;
    else overdue++;
  }
  return { today, upcoming, overdue, total: today + upcoming + overdue };
}

export function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Plain-text digest of real deliveries for one bucket, used as the body of a real email sent via POST /integrations/email/send. */
export function buildReminderEmailBody(bucket: DeliveryBucket, deliveries: DeliveryTransaction[], productsById: Map<number, Product>): string {
  const lines = deliveries.map((d) => {
    const party = d.type === "INCOMING" ? d.supplier?.name ?? "Unknown supplier" : d.partyName ?? "Unknown customer";
    const qty = d.items.reduce((sum, it) => sum + it.quantity, 0);
    const firstProduct = d.items[0] ? productsById.get(d.items[0].productId)?.name ?? `Product #${d.items[0].productId}` : "no items";
    const eta = d.expectedDate ? new Date(d.expectedDate).toLocaleDateString() : "no date";
    return `TXN-${d.id} (${d.type}) — ${party} — ${firstProduct}${d.items.length > 1 ? ` +${d.items.length - 1} more` : ""} — ${qty} units — expected ${eta}`;
  });
  return [`Nexora ERP — ${bucket} deliveries digest`, `${deliveries.length} transaction(s)`, "", ...lines].join("\n");
}
