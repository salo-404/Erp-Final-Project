/**
 * Seed data for this mockup's in-memory state (see AppDataContext.tsx).
 * Product/supplier names are deliberately the same ones used by
 * ai-agent-ui/src/mock-data.ts (Mechanical Keyboard, Nordic Components AB,
 * etc.) so a demo walking through this mockup and the AI-facing components
 * tells one consistent story - not a hard requirement, just kept in sync
 * on purpose.
 */

import type { Order, Product, Supplier, Warehouse } from "../types";

export const initialWarehouses: Warehouse[] = [
  { id: "wh-1", name: "London Central", location: "London, UK", capacity: 5000 },
  { id: "wh-2", name: "Manchester North", location: "Manchester, UK", capacity: 3200 },
  { id: "wh-3", name: "Dublin East", location: "Dublin, IE", capacity: 2100 },
];

export const initialProducts: Product[] = [
  // --- London Central ---
  { id: "prod-1", warehouseId: "wh-1", name: "USB-C Docking Station", category: "Docking Stations & Accessories", quantityOnHand: 12 },
  { id: "prod-2", warehouseId: "wh-1", name: "Wireless Mouse", category: "Peripherals", quantityOnHand: 58 },
  { id: "prod-3", warehouseId: "wh-1", name: "Thermal Paste 5g Tube", category: "Components", quantityOnHand: 40 },
  { id: "prod-4", warehouseId: "wh-1", name: "27\" Monitor", category: "Displays", quantityOnHand: 9 },

  // --- Manchester North ---
  { id: "prod-5", warehouseId: "wh-2", name: "Mechanical Keyboard", category: "Peripherals", quantityOnHand: 6 },
  { id: "prod-6", warehouseId: "wh-2", name: "Wireless Mouse", category: "Peripherals", quantityOnHand: 31 },
  { id: "prod-7", warehouseId: "wh-2", name: "USB-C Docking Station", category: "Docking Stations & Accessories", quantityOnHand: 22 },

  // --- Dublin East ---
  { id: "prod-8", warehouseId: "wh-3", name: "27\" Monitor", category: "Displays", quantityOnHand: 14 },
  { id: "prod-9", warehouseId: "wh-3", name: "Mechanical Keyboard", category: "Peripherals", quantityOnHand: 27 },
  { id: "prod-10", warehouseId: "wh-3", name: "Thermal Paste 5g Tube", category: "Components", quantityOnHand: 65 },
];

export const initialSuppliers: Supplier[] = [
  { id: "sup-5", name: "Nordic Components AB" },
  { id: "sup-7", name: "Global Peripherals Ltd" },
  { id: "sup-12", name: "Rapid Source Trading" },
  { id: "sup-3", name: "Pixel Display Co" },
];

export const initialOrders: Order[] = [
  {
    id: "ord-1",
    warehouseId: "wh-2",
    warehouseName: "Manchester North",
    productId: "prod-5",
    productName: "Mechanical Keyboard",
    amount: 40,
    supplierId: "sup-7",
    supplierName: "Global Peripherals Ltd",
    status: "Sent to Supplier",
    createdAt: "2026-08-16T10:15:00",
  },
  {
    id: "ord-2",
    warehouseId: "wh-1",
    warehouseName: "London Central",
    productId: "prod-1",
    productName: "USB-C Docking Station",
    amount: 30,
    supplierId: "sup-5",
    supplierName: "Nordic Components AB",
    status: "Invoice Received",
    createdAt: "2026-08-14T09:00:00",
  },
  {
    id: "ord-3",
    warehouseId: "wh-1",
    warehouseName: "London Central",
    productId: "prod-2",
    productName: "Wireless Mouse",
    amount: 50,
    supplierId: "sup-5",
    supplierName: "Nordic Components AB",
    status: "Discrepancy Flagged",
    createdAt: "2026-08-10T09:00:00",
  },
  {
    id: "ord-4",
    warehouseId: "wh-3",
    warehouseName: "Dublin East",
    productId: "prod-8",
    productName: '27" Monitor',
    amount: 10,
    supplierId: "sup-3",
    supplierName: "Pixel Display Co",
    status: "Fulfilled",
    createdAt: "2026-07-28T09:00:00",
  },
  {
    id: "ord-5",
    warehouseId: "wh-2",
    warehouseName: "Manchester North",
    productId: "prod-7",
    productName: "USB-C Docking Station",
    amount: 20,
    supplierId: "sup-12",
    supplierName: "Rapid Source Trading",
    status: "Pending",
    createdAt: "2026-08-17T14:30:00",
  },
];
