"""Mocked backend responses for every Insights tool.

Shapes mirror tools/schemas/insights_schema.py, which in turn mirrors the
Backend_vs_AI_Work_Split contract. Nothing here performs a real calculation -
every "score", "quantity", or "date" is a fixed, realistic-looking sample so
the agent has something plausible to interpret and narrate.
"""

from __future__ import annotations

from datetime import datetime, timedelta

_NOW = datetime(2026, 8, 15, 9, 0, 0)


def get_available_stock_mock(product_ids: list[int] | None = None) -> dict:
    """All available-stock rows, optionally filtered to specific product_ids.

    product_ids=None (default) returns everything - the general "what's our
    stock position" view. Passing product_ids narrows to exactly those
    products, e.g. to check availability for the specific line items on an
    order the Document agent just extracted, rather than the whole catalog.
    """
    items = [
        {
            "productId": 101,
            "productName": "Wireless Mouse",
            "warehouseId": 1,
            "warehouseName": "London Central",
            "onHand": 340,
            "reserved": 45,
            "available": 295,
        },
        {
            "productId": 102,
            "productName": "USB-C Docking Station",
            "warehouseId": 1,
            "warehouseName": "London Central",
            "onHand": 12,
            "reserved": 8,
            "available": 4,
        },
        {
            "productId": 103,
            "productName": "27in Monitor",
            "warehouseId": 2,
            "warehouseName": "Manchester North",
            "onHand": 58,
            "reserved": 10,
            "available": 48,
        },
        {
            "productId": 108,
            "productName": "Mechanical Keyboard",
            "warehouseId": 2,
            "warehouseName": "Manchester North",
            "onHand": 6,
            "reserved": 2,
            "available": 4,
        },
    ]
    if product_ids is not None:
        wanted = set(product_ids)
        items = [item for item in items if item["productId"] in wanted]

    return {
        "items": items,
        "asOf": _NOW.isoformat(),
    }


def get_low_stock_products_mock() -> dict:
    return {
        "items": [
            {
                "productId": 102,
                "productName": "USB-C Docking Station",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "onHand": 12,
                "reorderThreshold": 25,
                "deficit": 13,
            },
            {
                "productId": 108,
                "productName": "Mechanical Keyboard",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "onHand": 6,
                "reorderThreshold": 20,
                "deficit": 14,
            },
        ],
        "asOf": _NOW.isoformat(),
    }


def get_stockout_risk_mock() -> dict:
    return {
        "items": [
            {
                "productId": 102,
                "productName": "USB-C Docking Station",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "riskLevel": "HIGH",
                "riskScore": 0.82,
                "projectedStockoutDate": (_NOW + timedelta(days=6)).isoformat(),
                "averageDailyConsumption": 2.1,
            },
            {
                "productId": 108,
                "productName": "Mechanical Keyboard",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "riskLevel": "CRITICAL",
                "riskScore": 0.95,
                "projectedStockoutDate": (_NOW + timedelta(days=2)).isoformat(),
                "averageDailyConsumption": 3.4,
            },
            {
                "productId": 101,
                "productName": "Wireless Mouse",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "riskLevel": "LOW",
                "riskScore": 0.08,
                "projectedStockoutDate": None,
                "averageDailyConsumption": 4.7,
            },
        ],
        "asOf": _NOW.isoformat(),
    }


def get_restock_recommendations_mock() -> dict:
    return {
        "recommendations": [
            {
                "productId": 102,
                "productName": "USB-C Docking Station",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "needsReorder": True,
                "reason": "BELOW_THRESHOLD",
                "quantity": 60,
                "candidate": {
                    "supplierId": 5,
                    "supplierName": "Nordic Components AB",
                    "unitCost": 34.50,
                    "leadTimeDays": 9,
                },
            },
            {
                "productId": 108,
                "productName": "Mechanical Keyboard",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "needsReorder": True,
                "reason": "STOCKOUT_PREDICTED",
                "quantity": 80,
                "candidate": {
                    "supplierId": 7,
                    "supplierName": "Global Peripherals Ltd",
                    "unitCost": 41.20,
                    "leadTimeDays": 14,
                },
            },
            {
                "productId": 103,
                "productName": "27in Monitor",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "needsReorder": False,
                "reason": "SEASONAL_DEMAND",
                "quantity": 0,
                "candidate": {
                    "supplierId": 3,
                    "supplierName": "Pixel Display Co",
                    "unitCost": 189.00,
                    "leadTimeDays": 21,
                },
            },
        ],
        "asOf": _NOW.isoformat(),
    }


def get_transfer_recommendations_mock() -> dict:
    return {
        "recommendations": [
            {
                "productId": 103,
                "productName": "27in Monitor",
                "sourceWarehouseId": 2,
                "sourceWarehouseName": "Manchester North",
                "destinationWarehouseId": 1,
                "destinationWarehouseName": "London Central",
                "quantity": 15,
                "reason": "Destination below threshold, source has surplus above safety stock.",
            },
        ],
        "asOf": _NOW.isoformat(),
    }


def get_expiry_risk_mock() -> dict:
    return {
        "items": [
            {
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
        ],
        "asOf": _NOW.isoformat(),
    }


def analyze_dead_stock_mock() -> dict:
    return {
        "items": [
            {
                "productId": 340,
                "productName": "VGA to HDMI Adapter",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "onHand": 120,
                "daysSinceLastMovement": 187,
                "reason": "NO_MOVEMENT",
                "tiedUpCapital": 960.00,
            },
        ],
        "asOf": _NOW.isoformat(),
    }


def get_consumption_anomalies_mock() -> dict:
    return {
        "anomalies": [
            {
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
        ],
        "asOf": _NOW.isoformat(),
    }


def calculate_reorder_quantity_mock(product_id: int, warehouse_id: int) -> dict:
    return {
        "productId": product_id,
        "warehouseId": warehouse_id,
        "recommendedQuantity": 60,
        "method": "economic_order_quantity",
    }


def compare_suppliers_mock(product_id: int) -> dict:
    return {
        "productId": product_id,
        "scores": [
            {
                "supplierId": 5,
                "supplierName": "Nordic Components AB",
                "unitCost": 34.50,
                "leadTimeDays": 9,
                "reliabilityScore": 0.97,
                "overallScore": 0.91,
            },
            {
                "supplierId": 7,
                "supplierName": "Global Peripherals Ltd",
                "unitCost": 29.90,
                "leadTimeDays": 21,
                "reliabilityScore": 0.74,
                "overallScore": 0.68,
            },
            {
                "supplierId": 12,
                "supplierName": "Rapid Source Trading",
                "unitCost": 31.10,
                "leadTimeDays": 5,
                "reliabilityScore": 0.88,
                "overallScore": 0.87,
            },
        ],
        "recommendedSupplier": {
            "supplierId": 5,
            "supplierName": "Nordic Components AB",
            "unitCost": 34.50,
            "leadTimeDays": 9,
            "reliabilityScore": 0.97,
            "overallScore": 0.91,
        },
    }


def get_open_purchase_orders_mock() -> dict:
    return {
        "orders": [
            {
                "purchaseOrderId": 482,
                "supplierId": 5,
                "supplierName": "Nordic Components AB",
                "warehouseId": 1,
                "warehouseName": "London Central",
                "status": "IN_TRANSIT",
                "expectedDate": (_NOW + timedelta(days=3)).isoformat(),
                "lineItemCount": 2,
                "totalValue": 2070.00,
            },
            {
                "purchaseOrderId": 501,
                "supplierId": 7,
                "supplierName": "Global Peripherals Ltd",
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "status": "PENDING",
                "expectedDate": (_NOW + timedelta(days=17)).isoformat(),
                "lineItemCount": 1,
                "totalValue": 3296.00,
            },
        ],
        "asOf": _NOW.isoformat(),
    }


def draft_purchase_order_mock(product_id: int, warehouse_id: int, quantity: int) -> dict:
    return {
        "supplierId": 5,
        "supplierName": "Nordic Components AB",
        "warehouseId": warehouse_id,
        "warehouseName": "London Central" if warehouse_id == 1 else "Manchester North",
        "lineItems": [
            {
                "productId": product_id,
                "productName": "USB-C Docking Station",
                "quantity": quantity,
                "unitCost": 34.50,
            },
        ],
        "estimatedTotal": round(quantity * 34.50, 2),
        "estimatedLeadTimeDays": 9,
        "isDraft": True,
    }
