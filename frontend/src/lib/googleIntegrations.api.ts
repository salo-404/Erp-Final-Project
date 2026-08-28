import { apiRequest } from "./api-client";
import type { GoogleCalendarEvent, SendEmailResult, ShipmentReminderResult } from "../types/domain";

// Real Google Calendar/Gmail-backed endpoints (backend/src/integrations) —
// genuinely fail (HTTP 500) when the backend has no OAuth credentials
// configured. Callers must handle that as a real error state, never a
// silent fallback.

export function getGoogleCalendarEvents(startDate?: string, endDate?: string): Promise<GoogleCalendarEvent[]> {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const qs = params.toString();
  return apiRequest<GoogleCalendarEvent[]>(`/integrations/calendar/events${qs ? `?${qs}` : ""}`);
}

export function createShipmentReminder(transactionId: number): Promise<ShipmentReminderResult> {
  return apiRequest<ShipmentReminderResult>("/integrations/calendar/shipment-reminder", {
    method: "POST",
    body: { transactionId },
  });
}

export function sendEmail(to: string, subject: string, body: string): Promise<SendEmailResult> {
  return apiRequest<SendEmailResult>("/integrations/email/send", {
    method: "POST",
    body: { to, subject, body },
  });
}
