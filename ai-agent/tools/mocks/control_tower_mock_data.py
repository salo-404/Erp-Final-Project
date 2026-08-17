"""Mocked alert feed for the Control Tower narration layer.

get_mock_control_tower_alerts() stands in for the backend's not-yet-built
getControlTowerAlerts(). Evidence dicts deliberately reuse field names and,
where the same underlying situation is being described, the same sample
data as tools/mocks/insights_mock_data.py and
tools/mocks/document_mock_data.py - e.g. the stockout_risk alert below
mirrors get_stockout_risk_mock()'s Mechanical Keyboard entry, and the
invoice_discrepancy alert reuses the same document_id as
detect_discrepancy_mock()'s discrepant example - so narration output stays
consistent with what the rest of the system would say about the same
product/document if you asked it directly.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from tools.mocks.document_mock_data import KNOWN_INVOICE_DOCUMENT_ID, KNOWN_ORDER_DOCUMENT_ID
from tools.schemas.control_tower_schema import Alert

_NOW = datetime(2026, 8, 15, 9, 0, 0)


def get_mock_control_tower_alerts() -> list[Alert]:
    """Return the mock alert set as real Alert instances - one per entry below, at least one per category.

    Stands in for the backend's not-yet-built getControlTowerAlerts(),
    which will presumably also hand back already-validated Alert-shaped
    records rather than raw dicts - so this validates each mock record
    through Alert.model_validate() here, once, rather than pushing that
    step onto every caller.
    """
    raw_alerts: list[dict] = [
        # --- low_stock ------------------------------------------------
        # Mirrors get_low_stock_products_mock()'s USB-C Docking Station entry.
        {
            "id": "alert-001",
            "category": "low_stock",
            "severity": "high",
            "evidence": {
                "productId": 102,
                "productName": "USB-C Docking Station",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "onHand": 12,
                "reorderThreshold": 25,
                "deficit": 13,
            },
            "product_id": 102,
            "warehouse_id": 1,
        },
        # A second low_stock alert on a different product/warehouse, deliberately
        # the same product as the stockout_risk alert below - a product commonly
        # triggers more than one alert category at once.
        {
            "id": "alert-002",
            "category": "low_stock",
            "severity": "critical",
            "evidence": {
                "productId": 108,
                "productName": "Mechanical Keyboard",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "onHand": 6,
                "reorderThreshold": 20,
                "deficit": 14,
            },
            "product_id": 108,
            "warehouse_id": 2,
        },
        # --- stockout_risk ----------------------------------------------
        # Mirrors get_stockout_risk_mock()'s Mechanical Keyboard entry exactly.
        {
            "id": "alert-003",
            "category": "stockout_risk",
            "severity": "critical",
            "evidence": {
                "productId": 108,
                "productName": "Mechanical Keyboard",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "riskLevel": "CRITICAL",
                "riskScore": 0.95,
                "projectedStockoutDate": (_NOW + timedelta(days=2)).isoformat(),
                "averageDailyConsumption": 3.4,
            },
            "product_id": 108,
            "warehouse_id": 2,
        },
        # --- overdue_transaction ------------------------------------------
        # A purchase order past its expected delivery date, still not received.
        {
            "id": "alert-004",
            "category": "overdue_transaction",
            "severity": "high",
            "evidence": {
                "purchaseOrderId": 445,
                "supplierId": 12,
                "supplierName": "Rapid Source Trading",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "status": "PENDING",
                "expectedDate": (_NOW - timedelta(days=5)).isoformat(),
                "daysOverdue": 5,
                "lineItemCount": 1,
                "totalValue": 1866.00,
            },
            "product_id": None,
            "warehouse_id": 1,
        },
        # --- consumption_anomaly ------------------------------------------
        # Mirrors get_consumption_anomalies_mock()'s Wireless Mouse SPIKE entry.
        {
            "id": "alert-005",
            "category": "consumption_anomaly",
            "severity": "medium",
            "evidence": {
                "productId": 101,
                "productName": "Wireless Mouse",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "anomalyType": "SPIKE",
                "observedQuantity": 58,
                "expectedQuantity": 22,
                "deviationPercent": 163.6,
                "detectedAt": (_NOW - timedelta(days=1)).isoformat(),
            },
            "product_id": 101,
            "warehouse_id": 1,
        },
        # --- expiring_inventory ------------------------------------------
        # Mirrors get_expiry_risk_mock()'s Thermal Paste entry.
        {
            "id": "alert-006",
            "category": "expiring_inventory",
            "severity": "high",
            "evidence": {
                "productId": 210,
                "productName": "Thermal Paste 5g Tube",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "batchId": "TP-2025-11-B",
                "quantity": 40,
                "expiryDate": (_NOW + timedelta(days=18)).isoformat(),
                "daysUntilExpiry": 18,
                "riskLevel": "HIGH",
            },
            "product_id": 210,
            "warehouse_id": 1,
        },
        # --- invoice_discrepancy ------------------------------------------
        # Reuses detect_discrepancy_mock()'s discrepant example, tied to the
        # same known invoice document_id used throughout the Document agent's
        # own tests.
        {
            "id": "alert-007",
            "category": "invoice_discrepancy",
            "severity": "medium",
            "evidence": {
                "documentId": KNOWN_INVOICE_DOCUMENT_ID,
                "discrepancies": [
                    {
                        "type": "QUANTITY_MISMATCH",
                        "productId": 102,
                        "productName": "USB-C Docking Station",
                        "expectedValue": "50",
                        "actualValue": "60",
                        "severity": "MEDIUM",
                    },
                    {
                        "type": "PRICE_MISMATCH",
                        "productId": 101,
                        "productName": "Wireless Mouse",
                        "expectedValue": "7.50",
                        "actualValue": "8.20",
                        "severity": "LOW",
                    },
                ],
                "comparedAgainst": "purchaseOrderId=482",
            },
            "product_id": 102,
            "warehouse_id": 1,
        },
        # --- order_discrepancy ------------------------------------------
        # Tied to the known order document_id - a different discrepancy type
        # (UNEXPECTED_LINE_ITEM/quantity-well-above-usual) than the invoice
        # example above, for variety.
        {
            "id": "alert-008",
            "category": "order_discrepancy",
            "severity": "medium",
            "evidence": {
                "documentId": KNOWN_ORDER_DOCUMENT_ID,
                "discrepancies": [
                    {
                        "type": "UNEXPECTED_LINE_ITEM",
                        "productId": 108,
                        "productName": "Mechanical Keyboard",
                        "expectedValue": "not part of this customer's typical order profile",
                        "actualValue": "25 units",
                        "severity": "MEDIUM",
                    },
                ],
                "comparedAgainst": "customerId=44 standing order profile",
            },
            "product_id": 108,
            "warehouse_id": 2,
        },
    ]
    return [Alert.model_validate(raw) for raw in raw_alerts]
