// Mirrors backend/prisma/schema.prisma — only fields that actually exist.
// No Code/Type/Manager fields on Warehouse; no sku on Product.
export interface Warehouse {
  id: number;
  name: string;
  location: string | null;
  maxCapacity: number | null;
  isActive: boolean;
  createdAt: string;
}

export interface Product {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface WarehouseInventory {
  id: number;
  productId: number;
  warehouseId: number;
  onHand: number;
  reorderThreshold: number;
  product?: Product;
}

export interface WarehouseCatalog extends Warehouse {
  inventories: WarehouseInventory[];
}

export interface WarehouseCapacity {
  warehouseId: number;
  maxCapacity: number | null;
  currentStock: number;
  remainingCapacity: number | null;
}

export type StockMovementType = "INCOMING" | "OUTGOING" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUSTMENT";

export interface StockMovement {
  id: number;
  productId: number;
  warehouseId: number;
  type: StockMovementType;
  quantity: number;
  transactionId: number | null;
  createdAt: string;
}

export type InventoryTransactionType = "INCOMING" | "OUTGOING" | "TRANSFER";

export interface InventoryTransactionSummary {
  id: number;
  type: InventoryTransactionType;
  sourceWarehouseId: number | null;
  destinationWarehouseId: number | null;
  supplierId: number | null;
  partyName: string | null;
  createdAt: string;
  expectedDate: string | null;
  actualDate: string | null;
  documentUrl: string | null;
  documentKey: string | null;
}

export interface WarehouseAvailability {
  productId: number;
  onHand: number;
  reserved: number;
  available: number;
}

export interface WarehouseReservedTotal {
  warehouseId: number;
  totalReserved: number;
}

export interface InventoryTransactionItem {
  id: number;
  transactionId: number;
  productId: number;
  quantity: number;
}

export type InventoryTransactionStatus = "PENDING" | "COMPLETED" | "CANCELLED";

export interface InventoryTransactionWithItems extends InventoryTransactionSummary {
  status: InventoryTransactionStatus;
  items: InventoryTransactionItem[];
}

export interface Supplier {
  id: number;
  name: string;
  email: string | null;
  leadTimeDays: number | null;
  isActive: boolean;
  createdAt: string;
}

export interface ProductAvailability {
  warehouseId: number;
  productId: number;
  onHand: number;
  reserved: number;
  available: number;
}

export interface WarehouseInventoryWithWarehouse extends WarehouseInventory {
  warehouse: Warehouse;
}

export interface SupplierRankingComponentScores {
  price: number | null;
  onTimeDelivery: number | null;
  cancellationPerformance: number;
  productSupplyHistory: number | null;
}

// Mirrors backend/src/suppliers/supplier-intelligence.service.ts's RankedSupplier.
export interface RankedSupplier {
  supplierId: number;
  supplierName: string;
  productId: number;
  totalTransactions: number;
  completedTransactions: number;
  cancelledTransactions: number;
  cancellationRate: number;
  averagePrice: number | null;
  pricedItemCount: number;
  onTimeDeliveryRate: number | null;
  evaluatedForOnTimeCount: number;
  purchaseFrequency: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
  rank: number | null;
  score: number | null;
  insufficientData: boolean;
  insufficientDataReasons: string[];
  componentScores: SupplierRankingComponentScores;
}

export type StockoutRiskLevel = "OUT_OF_STOCK" | "AT_RISK" | "OK";

// Mirrors backend/src/stock-insights/stock-insights.service.ts's RestockRecommendation.
export interface RestockRecommendation {
  productId: number;
  warehouseId: number;
  available: number;
  pendingIncomingQuantity: number;
  projectedAvailable: number;
  reorderThreshold: number;
  riskLevel: StockoutRiskLevel;
  projectedRiskLevel: StockoutRiskLevel;
  recommendedQuantity: number;
  avgDailyConsumption: number;
  daysOfSupply: number | null;
  reason: string;
  transferSourceWarehouseIds: number[];
  predictedStockoutDate: string | null;
  explanation: string;
}

export interface ProductDemandWarehouse {
  warehouseId: number;
  warehouseName: string;
  quantitySold: number;
}

export interface ProductDemand {
  productId: number;
  productName: string;
  totalQuantitySold: number;
  totalRevenue: number;
  warehouseDemand: ProductDemandWarehouse[];
}

export interface StockHistoryEntry extends StockMovement {
  warehouse: Warehouse;
}

export interface CreateProductInput {
  name: string;
  category?: string;
  description?: string;
}

export interface UpdateProductInput {
  name?: string;
  category?: string;
  description?: string;
  isActive?: boolean;
}

export interface CreateSupplierInput {
  name: string;
  email?: string;
  leadTimeDays?: number;
}

export interface UpdateSupplierInput {
  name?: string;
  email?: string;
  leadTimeDays?: number;
  isActive?: boolean;
}

// Mirrors backend/src/suppliers/supplier-intelligence.service.ts's
// SupplierStats — unscoped (whole supplier history), unlike RankedSupplier
// which is scoped to one product.
export interface SupplierStats {
  supplierId: number;
  totalTransactions: number;
  completedTransactions: number;
  cancelledTransactions: number;
  cancellationRate: number;
  averagePrice: number | null;
  pricedItemCount: number;
  onTimeDeliveryRate: number | null;
  evaluatedForOnTimeCount: number;
  purchaseFrequency: number;
  firstPurchaseDate: string | null;
  lastPurchaseDate: string | null;
}

export interface SupplierTransactionHistoryItem {
  id: number;
  transactionId: number;
  productId: number;
  quantity: number;
  price: string | null;
  product: Product;
}

export interface SupplierTransaction {
  id: number;
  type: InventoryTransactionType;
  status: InventoryTransactionStatus;
  createdAt: string;
  expectedDate: string | null;
  actualDate: string | null;
  destinationWarehouseId: number | null;
  items: SupplierTransactionHistoryItem[];
}

export interface SupplierTransactionHistory extends Supplier {
  transactions: SupplierTransaction[];
}

export interface CreateIncomingInput {
  supplierId: number;
  destinationWarehouseId: number;
  expectedDate?: string;
  items: { productId: number; quantity: number; price: number }[];
}

export interface CreateOutgoingInput {
  sourceWarehouseId: number;
  partyName?: string;
  deliveryCountry?: string;
  deliveryRegion?: string;
  deliveryAddress?: string;
  expectedDate?: string;
  items: { productId: number; quantity: number; price?: number }[];
}

export interface CreateTransferInput {
  sourceWarehouseId: number;
  destinationWarehouseId: number;
  expectedDate?: string;
  items: { productId: number; quantity: number; price?: number }[];
}

export interface PendingDocumentReview {
  id: number;
  documentUrl: string;
  documentKey: string | null;
  transactionType: InventoryTransactionType;
  extractedPartyName: string | null;
  extractedSupplierName: string | null;
  extractedDate: string | null;
  extractedWarehouseName: string | null;
  extractedDeliveryCountry: string | null;
  extractedDeliveryRegion: string | null;
  extractedDeliveryAddress: string | null;
  extractedItems: { product: string; quantity: number; price?: number }[];
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  rejectionReason: string | null;
  reviewedById: number | null;
  reviewedAt: string | null;
  transactionId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingDocumentReviewWithDetails extends PendingDocumentReview {
  transaction: InventoryTransactionWithItems | null;
  reviewedBy: { id: number; name: string; email: string } | null;
}

/**
 * One real candidate the Document agent (or, when it's unavailable, the
 * fuzzy fallback — see backend/src/document-review/document-review.service.ts)
 * considered for an extracted product/supplier name. id/name always trace
 * back to a real Product/Supplier row — never invented. confidence is 0-1.
 * reason is always a real, specific sentence, never a placeholder.
 */
export interface DocumentMatchCandidate {
  id: number;
  name: string;
  confidence: number;
  reason: string;
}

/** Only ever present when status is NO_MATCH for a product — never for a supplier. */
export interface DocumentMatchRecommendation {
  normalizedName: string;
  category: string | null;
  description: string | null;
}

/**
 * The full result of matching one extracted name against the real catalog
 * — up to 3 real candidates, never collapsed into a bare name/score pair.
 * Human review is still mandatory either way: nothing here is auto-applied.
 */
export interface DocumentMatchResult {
  status: "RESOLVED" | "UNRESOLVED" | "NO_MATCH";
  candidates: DocumentMatchCandidate[];
  recommendation: DocumentMatchRecommendation | null;
}

/**
 * A brand-new product, created ATOMICALLY inside the same backend approval
 * transaction that creates the resulting inventory transaction — never
 * created ahead of time. Only valid for an INCOMING review's line item;
 * rolled back along with everything else in approve() if anything in the
 * batch fails (a duplicate name, another line, etc).
 */
export interface NewProductDefinition {
  name: string;
  category?: string | null;
}

export interface ApproveDocumentReviewInput {
  items: {
    /** Set for a line resolved to an existing product — mutually exclusive with newProduct. */
    productId?: number;
    /** Set for a line defining a brand-new INCOMING product instead — see NewProductDefinition. */
    newProduct?: NewProductDefinition;
    quantity: number;
    price?: number;
  }[];
  expectedDate?: string;
  supplierId?: number;
  destinationWarehouseId?: number;
  sourceWarehouseId?: number;
  partyName?: string;
  deliveryCountry?: string;
  deliveryRegion?: string;
  deliveryAddress?: string;
}

export interface CreateWarehouseInput {
  name: string;
  location?: string;
  maxCapacity?: number;
}

export interface UpdateWarehouseInput {
  name?: string;
  location?: string;
  maxCapacity?: number;
  isActive?: boolean;
}

// --- Control Tower (GET /control-tower/alerts) ---

export type ControlTowerAlertSeverity = "CRITICAL" | "WARNING" | "INFO";

export type ControlTowerAlertCategory =
  | "DEAD_STOCK"
  | "CONSUMPTION_ANOMALY"
  | "STOCKOUT_RISK"
  | "OVERDUE_TRANSACTION"
  | "PENDING_DOCUMENT_REVIEW"
  | "RESTOCK_RECOMMENDATION"
  | "TRANSFER_RECOMMENDATION";

export interface ControlTowerAlert {
  category: ControlTowerAlertCategory;
  severity: ControlTowerAlertSeverity;
  message: string;
  data: Record<string, unknown>;
  referenceDate: string;
}

export interface DeadStockAlertData {
  productId: number;
  warehouseId: number;
  onHand: number;
  lastMovementAt: string | null;
  daysSinceLastMovement: number | null;
  lastOutgoingMovementAt: string | null;
  daysSinceLastOutgoingMovement: number | null;
}

export interface ConsumptionAnomalyAlertData {
  productId: number;
  warehouseId: number;
  recentQuantity: number;
  baselineQuantity: number;
  percentChange: number | null;
  direction: "INCREASE" | "DECREASE";
}

export interface StockoutRiskAlertData {
  productId: number;
  warehouseId: number;
  onHand: number;
  activeReserved: number;
  available: number;
  reorderThreshold: number;
  riskLevel: StockoutRiskLevel;
  pendingIncomingQuantity: number;
  projectedAvailable: number;
  projectedRiskLevel: StockoutRiskLevel;
  avgDailyConsumption: number;
  daysOfSupply: number | null;
  predictedStockoutDate: string | null;
}

// RESTOCK_RECOMMENDATION alert data is the existing RestockRecommendation
// type above (already used by Product Detail) — not redefined here.

export interface TransferRecommendationAlertData {
  productId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  transferQuantity: number;
  fromWarehouseAvailableAfterTransfer: number;
  toWarehouseProjectedAvailableAfterTransfer: number;
  sourcePendingIncomingQuantity: number;
  sourceIsDeadStock: boolean;
  destinationRiskLevel: StockoutRiskLevel;
  destinationAvgDailyConsumption: number;
  destinationDaysOfSupply: number | null;
}

export interface OverdueTransactionAlertData {
  id: number;
  type: InventoryTransactionType;
  status: InventoryTransactionStatus;
  sourceWarehouseId: number | null;
  destinationWarehouseId: number | null;
  supplierId: number | null;
  expectedDate: string | null;
  items: { productId: number; quantity: number; price: string | null }[];
  supplier?: { id: number; name: string } | null;
}

export interface PendingDocumentReviewAlertData {
  id: number;
  transactionType: InventoryTransactionType;
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  extractedPartyName: string | null;
  extractedSupplierName: string | null;
  extractedWarehouseName: string | null;
}

// --- Analytics (backend/src/analytics) ---

export interface SalesTrendPoint {
  date: string;
  quantitySold: number;
  revenue: number;
  transactionCount: number;
}

export interface PurchaseTrendPoint {
  date: string;
  quantityPurchased: number;
  purchaseCost: number;
  transactionCount: number;
}

export interface ProductMovementStat {
  productId: number;
  name: string;
  quantityMoved: number;
}

export interface WarehouseDemand {
  warehouseId: number;
  warehouseName: string;
  totalQuantitySold: number;
  orderCount: number;
}

export interface SupplierComparisonEntry {
  supplierId: number;
  supplierName: string;
  completedTransactions: number;
  cancelledTransactions: number;
  onTimeTransactions: number;
  lateTransactions: number;
  totalPurchasedQuantity: number;
  totalPurchaseCost: number;
  averageUnitCost: number;
}

// --- Calendar / Deliveries (backend/src/inventory-transactions upcoming-deliveries + overdue) ---

export interface DeliveryTransaction extends InventoryTransactionWithItems {
  supplier: Supplier | null;
}

// --- Google Calendar / Gmail integrations (backend/src/integrations) ---
// Real Google-backed services — genuinely fail with a 500 when the
// backend's credentials/google-oauth.json + google-token.json don't exist
// (confirmed live: no fake fallback, no mocked success).

export interface GoogleCalendarEvent {
  id: string | null | undefined;
  title: string | null | undefined;
  description: string | null | undefined;
  startDate: string | null | undefined;
  endDate: string | null | undefined;
  eventLink: string | null | undefined;
}

export interface SendEmailResult {
  success: boolean;
  messageId: string;
}

export interface ShipmentReminderResult {
  success: boolean;
  eventId: string | null | undefined;
  eventLink: string | null | undefined;
}
