import { apiRequest } from "./api-client";
import type { RestockRecommendation } from "../types/domain";

export function getRestockRecommendations(): Promise<RestockRecommendation[]> {
  return apiRequest<RestockRecommendation[]>("/stock-insights/restock-recommendations");
}
