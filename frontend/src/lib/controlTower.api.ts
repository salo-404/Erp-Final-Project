import { apiRequest } from "./api-client";
import type { ControlTowerAlert } from "../types/domain";

export function getControlTowerAlerts(): Promise<ControlTowerAlert[]> {
  return apiRequest<ControlTowerAlert[]>("/control-tower/alerts");
}
