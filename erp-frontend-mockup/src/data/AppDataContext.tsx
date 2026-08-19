import { createContext, useContext, useState, type ReactNode } from "react";
import type { Order, OrderStatus, Product, Supplier, Warehouse } from "../types";
import { initialOrders, initialProducts, initialSuppliers, initialWarehouses } from "./mockData";

interface NewWarehouseInput {
  name: string;
  location: string;
  capacity: number;
}

interface NewOrderInput {
  warehouseId: string;
  productId: string;
  amount: number;
  supplierId: string;
}

interface AppDataValue {
  warehouses: Warehouse[];
  products: Product[];
  suppliers: Supplier[];
  orders: Order[];
  createWarehouse: (input: NewWarehouseInput) => void;
  updateWarehouse: (id: string, input: NewWarehouseInput) => void;
  deleteWarehouse: (id: string) => void;
  createOrder: (input: NewOrderInput) => Order;
}

const AppDataContext = createContext<AppDataValue | null>(null);

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * All mock ERP state for this mockup, held in memory only (React state,
 * cleared on refresh - see README.md, "no persistence needed" by design).
 */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>(initialWarehouses);
  const [products] = useState<Product[]>(initialProducts);
  const [suppliers] = useState<Supplier[]>(initialSuppliers);
  const [orders, setOrders] = useState<Order[]>(initialOrders);

  // MERGE-BACKEND: replace createWarehouse/updateWarehouse/deleteWarehouse
  // with real calls to the backend's Warehouses CRUD endpoints (see
  // Backend_vs_AI_Work_Split.md "Products, Warehouses, Suppliers"). These
  // currently only mutate local React state - nothing is persisted.
  function createWarehouse(input: NewWarehouseInput) {
    setWarehouses((prev) => [...prev, { id: makeId("wh"), ...input }]);
  }

  function updateWarehouse(id: string, input: NewWarehouseInput) {
    setWarehouses((prev) =>
      prev.map((warehouse) => (warehouse.id === id ? { ...warehouse, ...input } : warehouse)),
    );
  }

  function deleteWarehouse(id: string) {
    setWarehouses((prev) => prev.filter((warehouse) => warehouse.id !== id));
  }

  // MERGE-BACKEND: replace with a real call to the backend's order/
  // transaction creation endpoint plus its email service, which is what
  // actually notifies the supplier (see "Email / Calendar services" in
  // Backend_vs_AI_Work_Split.md). Today this only appends an Order to local
  // state with status "Sent to Supplier" - no request leaves the browser
  // and no email is sent.
  function createOrder(input: NewOrderInput): Order {
    const warehouse = warehouses.find((item) => item.id === input.warehouseId);
    const product = products.find((item) => item.id === input.productId);
    const supplier = suppliers.find((item) => item.id === input.supplierId);

    const order: Order = {
      id: makeId("ord"),
      warehouseId: input.warehouseId,
      warehouseName: warehouse?.name ?? "Unknown warehouse",
      productId: input.productId,
      productName: product?.name ?? "Unknown product",
      amount: input.amount,
      supplierId: input.supplierId,
      supplierName: supplier?.name ?? "Unknown supplier",
      // MERGE-AI: "Invoice Received" and "Discrepancy Flagged" (see the
      // OrderStatus union in types.ts) should eventually be states this
      // order transitions into automatically, driven by
      // ai-agent/agents/document_agent's extract_document(doc_type="invoice")
      // and detect_discrepancy() results once a real supplier invoice reply
      // triggers document ingestion - not something the UI sets itself.
      status: "Sent to Supplier" as OrderStatus,
      createdAt: new Date().toISOString(),
    };

    setOrders((prev) => [order, ...prev]);
    return order;
  }

  const value: AppDataValue = {
    warehouses,
    products,
    suppliers,
    orders,
    createWarehouse,
    updateWarehouse,
    deleteWarehouse,
    createOrder,
  };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataValue {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error("useAppData must be used within an AppDataProvider");
  }
  return context;
}
