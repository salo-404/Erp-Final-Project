# Nexora shared types

Port these to `packages/types` as Zod schemas. Backend (Nest DTOs) and frontend (TanStack Query response types) MUST match these.

```ts
// Common
type Status<T extends string> = T;

// Warehouse
export type Warehouse = {
  id: string;
  name: string;
  location: string;
  totalUnits: number;
  capacityPct: number;
  activeSkus: number;
  monthlyThroughput: number;
  categoriesPct: { name: string; pct: number; color: string }[];
  status: 'healthy' | 'warning' | 'critical';
};

// Product
export type Product = {
  sku: string;
  name: string;
  category: string;
  price: number;
  qty: number;
  status: 'healthy' | 'warning' | 'critical';
};

export type InventoryRow = Product & {
  available: number;
  reserved: number;
  inTheWay: number;
  arrived: number;
};

// Movement
export type MovementType = 'inbound' | 'outbound' | 'transfer' | 'adjustment';
export type Movement = {
  id: string;
  ts: string;
  type: MovementType;
  product: string;
  sku: string;
  qty: number;
  ref: string;
  related?: string;
};

// Supplier
export type Supplier = {
  id: string;
  name: string;
  category: string;
  rating: number;
  poCount: number;
};

export type SupplierPerformance = {
  supplierId: string;
  onTimePct: number;
  cancellationPct: number;
  avgPrice: number;
  purchaseFrequency: number;
  sparkline: { key: 'ot'|'cc'|'pr'|'fr'; points: number[] }[];
};

// Purchase & Arrival
export type PurchaseStatus = 'arrived' | 'transit' | 'expected' | 'delayed';
export type PurchaseArrival = {
  id: string;
  product: string;
  supplierId: string;
  supplier: string;
  qty: number;
  status: PurchaseStatus;
  dateInfo: string;
};

// Customer Order
export type CustomerOrderStage =
  | 'pending' | 'confirmed' | 'picking' | 'shipped' | 'delivered' | 'cancelled';
export type CustomerOrder = {
  id: string;
  customer: string;
  warehouseId: string;
  items: number;
  value: number;
  stage: CustomerOrderStage;
  deliveryDate: string;
};

// Delivery
export type DeliveryStatus = 'today' | 'upcoming' | 'overdue' | 'arrived';
export type Delivery = {
  id: string;
  po: string;
  supplierId: string;
  supplier: string;
  item: string;
  qty: number;
  scheduledFor: string; // ISO date
  eta: string;
  origin: string;
  status: DeliveryStatus;
};

// Invoice
export type Invoice = {
  id: string;
  doc: string;
  supplier: string;
  date: string;
  s3Key: string;
  status: 'uploaded' | 'processing' | 'ai_extracted' | 'pending_review' | 'approved' | 'rejected';
};

export type InvoiceExtraction = {
  invoiceId: string;
  confidence: number; // 0-100
  aiExtracted: {
    invoiceNo: string; supplier: string; date: string;
    total: string; currency: string; vat: string;
    items: { sku: string; name: string; qty: number; price: number; total: number }[];
  };
  erpRecord: {
    poRef: string; supplier: string; date: string; total: string;
    items: { sku: string; name: string; qty: number; price: number; total: number }[];
  };
};

// Issue (Control Tower)
export type IssueType = 'stockout' | 'restock' | 'transfer' | 'deadstock' | 'anomaly' | 'document';
export type Severity = 'critical' | 'warning' | 'info';
export type Issue = { id: string; type: IssueType; severity: Severity; /* type-specific fields */ };

// User
export type UserRole = 'admin' | 'manager' | 'worker';
export type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  warehouseId: string | 'all';
  active: boolean;
  lastActiveAt: string;
};

// Settings
export type NotificationPrefs = {
  emailDeliveryToday: boolean;
  emailDeliveryUpcoming: boolean;
  emailDeliveryOverdue: boolean;
  stockoutAlerts: boolean;
  newInvoice: boolean;
  weeklySummary: boolean;
};

export type AiPrefs = {
  chartsPreferred: boolean;
  autoActions: boolean;
  weeklyDigest: boolean;
  voice: boolean;
};

export type GeneralPrefs = {
  defaultWarehouseId: string;
  lowStockThreshold: number;
  currency: 'USD' | 'SAR' | 'AED' | 'EUR';
  timezone: string;
  dateFormat: 'DD MMM YYYY' | 'MMM DD, YYYY' | 'YYYY-MM-DD';
  landingPage: 'warehouses' | 'analytics' | 'inventory' | 'delivery';
};

// AI Agent
export type AiResponseType = 'text' | 'table' | 'chart' | 'kpi' | 'action' | 'done';
export type AiEvent =
  | { type: 'text'; payload: { markdown: string } }
  | { type: 'table'; payload: { columns: { key: string; label: string; align?: 'left'|'center'|'right' }[]; rows: Record<string, unknown>[]; meta?: string } }
  | { type: 'chart'; payload: { kind: 'bar'|'donut'|'line'; data: unknown; options?: unknown } }
  | { type: 'kpi'; payload: { label: string; value: string; delta?: string } }
  | { type: 'action'; payload: { label: string; href: string } }
  | { type: 'done'; payload: { sessionId: string } };
```
