import { apiRequest } from "./api-client";
import type { DeliveryTransaction } from "../types/domain";

export function getUpcomingDeliveries(windowDays: number): Promise<DeliveryTransaction[]> {
  return apiRequest<DeliveryTransaction[]>(`/inventory-transactions/upcoming-deliveries?windowDays=${windowDays}`);
}

export function getOverdueDeliveries(): Promise<DeliveryTransaction[]> {
  return apiRequest<DeliveryTransaction[]>("/inventory-transactions/overdue");
}
