/**
 * Local mock-only data shapes for this UI mockup. None of these are real
 * backend or AI schemas - see README.md for how each maps to a future real
 * integration point.
 */

export interface Warehouse {
  id: string;
  name: string;
  location: string;
  capacity: number;
}

export interface Product {
  id: string;
  warehouseId: string;
  name: string;
  category: string;
  quantityOnHand: number;
}

export interface Supplier {
  id: string;
  name: string;
}

export type OrderStatus =
  | "Pending"
  | "Sent to Supplier"
  | "Invoice Received"
  | "Discrepancy Flagged"
  | "Fulfilled";

export interface Order {
  id: string;
  warehouseId: string;
  warehouseName: string;
  productId: string;
  productName: string;
  amount: number;
  supplierId: string;
  supplierName: string;
  status: OrderStatus;
  createdAt: string;
}

/** One turn in the floating chat panel - local mock only, see ChatPanel.tsx. */
export interface MockChatMessage {
  role: "user" | "supervisor";
  content: string;
}
