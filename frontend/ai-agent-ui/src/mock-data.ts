/**
 * Mock data for the demo page (App.tsx). Every alert and supplier below is
 * derived directly from the AI layer's real mocks - same ids, product
 * names, warehouses, and evidence fields as:
 *   - ai-agent/tools/mocks/control_tower_mock_data.py (alerts)
 *   - ai-agent/tools/mocks/supplier_mock_data.py (suppliers)
 * The narrative/proposed_action/recommendation_context text below is
 * illustrative only (a plausible example of what
 * ai-agent/narration/control_tower.py and
 * ai-agent/narration/supplier_analysis.py would generate for this evidence)
 * - it is not copied from a real model run. Swap in real narration output
 * once the AI layer is wired up; the evidence/stat fields are the part
 * that must stay in sync with the Python mocks.
 */

import type { ChatMessage, NarratedAlert, SupplierNarration, ToolTrace } from "./types";

export const mockAlerts: NarratedAlert[] = [
  {
    id: "alert-001",
    category: "low_stock",
    severity: "high",
    evidence: {
      productId: 102,
      productName: "USB-C Docking Station",
      warehouseId: 1,
      warehouseName: "London Central",
      onHand: 12,
      reorderThreshold: 25,
      deficit: 13,
    },
    product_id: 102,
    warehouse_id: 1,
    narrative:
      "USB-C Docking Station at London Central has dropped to 12 units on hand, " +
      "13 below the 25-unit reorder threshold.",
    proposed_action:
      "Consider placing a restock order for USB-C Docking Station at London Central.",
  },
  {
    id: "alert-002",
    category: "low_stock",
    severity: "critical",
    evidence: {
      productId: 108,
      productName: "Mechanical Keyboard",
      warehouseId: 2,
      warehouseName: "Manchester North",
      onHand: 6,
      reorderThreshold: 20,
      deficit: 14,
    },
    product_id: 108,
    warehouse_id: 2,
    narrative:
      "Mechanical Keyboard at Manchester North is critically low - only 6 units remain " +
      "against a 20-unit threshold, a deficit of 14.",
    proposed_action:
      "Escalate a restock order for Mechanical Keyboard at Manchester North as a priority.",
  },
  {
    id: "alert-003",
    category: "stockout_risk",
    severity: "critical",
    evidence: {
      productId: 108,
      productName: "Mechanical Keyboard",
      warehouseId: 2,
      warehouseName: "Manchester North",
      riskLevel: "CRITICAL",
      riskScore: 0.95,
      projectedStockoutDate: "2026-08-17T09:00:00",
      averageDailyConsumption: 3.4,
    },
    product_id: 108,
    warehouse_id: 2,
    narrative:
      "At the current consumption rate of 3.4 units/day, Mechanical Keyboard at " +
      "Manchester North is projected to stock out on 2026-08-17.",
    proposed_action:
      "Review whether an expedited or partial shipment can arrive before the projected stockout date.",
  },
  {
    id: "alert-004",
    category: "overdue_transaction",
    severity: "high",
    evidence: {
      purchaseOrderId: 445,
      supplierId: 12,
      supplierName: "Rapid Source Trading",
      warehouseId: 1,
      warehouseName: "London Central",
      status: "PENDING",
      expectedDate: "2026-08-10T09:00:00",
      daysOverdue: 5,
      lineItemCount: 1,
      totalValue: 1866.0,
    },
    product_id: null,
    warehouse_id: 1,
    narrative:
      "Purchase order #445 with Rapid Source Trading, expected at London Central, " +
      "is now 5 days overdue and still marked pending.",
    proposed_action:
      "Follow up with Rapid Source Trading on the status of purchase order #445.",
  },
  {
    id: "alert-005",
    category: "consumption_anomaly",
    severity: "medium",
    evidence: {
      productId: 101,
      productName: "Wireless Mouse",
      warehouseId: 1,
      warehouseName: "London Central",
      anomalyType: "SPIKE",
      observedQuantity: 58,
      expectedQuantity: 22,
      deviationPercent: 163.6,
      detectedAt: "2026-08-14T09:00:00",
    },
    product_id: 101,
    warehouse_id: 1,
    narrative:
      "Wireless Mouse consumption at London Central spiked to 58 units against an " +
      "expected 22 - about 164% above normal.",
    proposed_action:
      "Check for a one-off cause (bulk order, promotion) before adjusting reorder planning.",
  },
  {
    id: "alert-006",
    category: "expiring_inventory",
    severity: "high",
    evidence: {
      productId: 210,
      productName: "Thermal Paste 5g Tube",
      warehouseId: 1,
      warehouseName: "London Central",
      batchId: "TP-2025-11-B",
      quantity: 40,
      expiryDate: "2026-09-02T09:00:00",
      daysUntilExpiry: 18,
      riskLevel: "HIGH",
    },
    product_id: 210,
    warehouse_id: 1,
    narrative:
      "Batch TP-2025-11-B of Thermal Paste 5g Tube (40 units) at London Central expires " +
      "in 18 days.",
    proposed_action:
      "Prioritize this batch for outgoing orders before it expires, or consider a markdown.",
  },
  {
    id: "alert-007",
    category: "invoice_discrepancy",
    severity: "medium",
    evidence: {
      documentId: "doc_inv_2026_0815_001",
      discrepancies: [
        {
          type: "QUANTITY_MISMATCH",
          productId: 102,
          productName: "USB-C Docking Station",
          expectedValue: "50",
          actualValue: "60",
          severity: "MEDIUM",
        },
        {
          type: "PRICE_MISMATCH",
          productId: 101,
          productName: "Wireless Mouse",
          expectedValue: "7.50",
          actualValue: "8.20",
          severity: "LOW",
        },
      ],
      comparedAgainst: "purchaseOrderId=482",
    },
    product_id: 102,
    warehouse_id: 1,
    narrative:
      "Invoice doc_inv_2026_0815_001 doesn't match purchase order #482: USB-C Docking " +
      "Station billed at 60 units instead of 50, and Wireless Mouse priced at $8.20 " +
      "instead of $7.50.",
    proposed_action:
      "Review invoice doc_inv_2026_0815_001 against purchase order #482 before approving payment.",
  },
  {
    id: "alert-008",
    category: "order_discrepancy",
    severity: "medium",
    evidence: {
      documentId: "doc_ord_2026_0815_001",
      discrepancies: [
        {
          type: "UNEXPECTED_LINE_ITEM",
          productId: 108,
          productName: "Mechanical Keyboard",
          expectedValue: "not part of this customer's typical order profile",
          actualValue: "25 units",
          severity: "MEDIUM",
        },
      ],
      comparedAgainst: "customerId=44 standing order profile",
    },
    product_id: 108,
    warehouse_id: 2,
    narrative:
      "Order doc_ord_2026_0815_001 includes 25 units of Mechanical Keyboard, a product " +
      "not normally part of customer #44's standing order profile.",
    proposed_action:
      "Confirm with customer #44 that the Mechanical Keyboard line item is intentional.",
  },
];

export const mockSuppliers: SupplierNarration[] = [
  {
    supplier_id: 5,
    name: "Nordic Components AB",
    unit_cost: 34.5,
    lead_time_days: 9,
    reliability_score: 0.97,
    overall_score: 0.91,
    recent_transaction_count: 42,
    on_time_delivery_rate: 0.95,
    product_categories: ["USB-C Docking Stations", "Computer Mice"],
    narrative:
      "Nordic Components AB is a highly reliable supplier - 97% reliability and 95% " +
      "on-time delivery across 42 recent transactions - at a moderate cost premium over " +
      "cheaper alternatives.",
    recommendation_context:
      "A strong fit when reliability matters more than shaving a few dollars off unit " +
      "cost, such as for products already at risk of stockout.",
  },
  {
    supplier_id: 7,
    name: "Global Peripherals Ltd",
    unit_cost: 29.9,
    lead_time_days: 21,
    reliability_score: 0.74,
    overall_score: 0.68,
    recent_transaction_count: 18,
    on_time_delivery_rate: 0.71,
    product_categories: ["Mechanical Keyboards", "Peripherals"],
    narrative:
      "Global Peripherals Ltd offers the lowest unit cost of the group, but reliability " +
      "(74%) and on-time delivery (71%) trail the others, with a 21-day lead time.",
    recommendation_context:
      "Best suited to non-urgent restocks with slack in the timeline, where cost savings " +
      "outweigh the risk of delay.",
  },
  {
    supplier_id: 12,
    name: "Rapid Source Trading",
    unit_cost: 31.1,
    lead_time_days: 5,
    reliability_score: 0.88,
    overall_score: 0.87,
    recent_transaction_count: 25,
    on_time_delivery_rate: 0.85,
    product_categories: ["General Hardware", "Fast-Turnaround Orders"],
    narrative:
      "Rapid Source Trading has the fastest lead time in the group (5 days) with solid " +
      "reliability (88%), at a mid-range unit cost.",
    recommendation_context:
      "A strong default choice for urgent restocks where waiting on a cheaper or more " +
      "reliable supplier isn't an option.",
  },
  {
    supplier_id: 3,
    name: "Pixel Display Co",
    unit_cost: 189.0,
    lead_time_days: 21,
    reliability_score: 0.9,
    overall_score: 0.75,
    recent_transaction_count: 15,
    on_time_delivery_rate: 0.89,
    product_categories: ["Monitors", "Displays"],
    narrative:
      "Pixel Display Co is a premium, reliable (90%) specialist for monitors and " +
      "displays, but at a significantly higher unit cost and a 21-day lead time.",
    recommendation_context:
      "Reasonable for display hardware where quality and reliability are prioritized " +
      "over cost, planned well ahead of the need date.",
  },
];

export const mockChatMessages: ChatMessage[] = [
  { role: "user", content: "What is at risk of stockout?" },
  {
    role: "supervisor",
    content:
      "Most urgent stockout risks:\n\n" +
      "1. Mechanical Keyboard — Manchester North\n" +
      "   Risk: CRITICAL, projected stockout 2026-08-17\n\n" +
      "2. USB-C Docking Station — London Central\n" +
      "   Risk: HIGH, projected stockout 2026-08-21\n\n" +
      "Want restock recommendations for either of these?",
  },
  { role: "user", content: "Yes, for the Mechanical Keyboard." },
];

export const mockToolTrace: ToolTrace[] = [
  {
    toolName: "get_stockout_risk",
    status: "success",
    summary: "Returned 2 products at HIGH or CRITICAL stockout risk.",
  },
  {
    toolName: "get_available_stock",
    status: "success",
    summary: "Checked on-hand quantity for Mechanical Keyboard (product_id=108).",
  },
  {
    toolName: "compare_suppliers",
    status: "error",
    summary: "No supplier_id provided - declined to guess, asked the caller to specify one.",
  },
];
