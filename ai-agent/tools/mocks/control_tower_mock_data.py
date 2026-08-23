"""Backend-shaped Control Tower alert fixtures for tests only.

Production narration fetches GET /control-tower/alerts and never imports this
module. These fixtures cover the frozen backend's seven categories without
duplicating alert calculation logic.
"""

from __future__ import annotations

from tools.schemas.control_tower_schema import Alert

_REFERENCE_DATE = "2026-08-15T09:00:00.000Z"


def get_mock_control_tower_alerts() -> list[Alert]:
    """Return one backend-shaped, validated test fixture per category."""
    raw_alerts = [
        {
            "category": "DEAD_STOCK",
            "severity": "INFO",
            "message": "Product 5 in warehouse 1 has 40 units on hand with no customer OUTGOING movement in 75 days",
            "data": {
                "productId": 5,
                "warehouseId": 1,
                "onHand": 40,
                "lastMovementAt": "2026-08-10T09:00:00.000Z",
                "daysSinceLastMovement": 5,
                "lastOutgoingMovementAt": "2026-06-01T09:00:00.000Z",
                "daysSinceLastOutgoingMovement": 75,
            },
            "referenceDate": _REFERENCE_DATE,
        },
        {
            "category": "CONSUMPTION_ANOMALY",
            "severity": "WARNING",
            "message": "Product 6 in warehouse 1 consumption increased 120.0%",
            "data": {
                "productId": 6,
                "warehouseId": 1,
                "recentQuantity": 44,
                "baselineQuantity": 20,
                "percentChange": 120.0,
                "direction": "INCREASE",
            },
            "referenceDate": _REFERENCE_DATE,
        },
        {
            "category": "STOCKOUT_RISK",
            "severity": "CRITICAL",
            "message": "Product 7 is out of stock in warehouse 2 (available: 0)",
            "data": {
                "productId": 7,
                "warehouseId": 2,
                "onHand": 8,
                "activeReserved": 8,
                "available": 0,
                "riskLevel": "OUT_OF_STOCK",
                "projectedAvailable": 0,
            },
            "referenceDate": _REFERENCE_DATE,
        },
        {
            "category": "OVERDUE_TRANSACTION",
            "severity": "WARNING",
            "message": "INCOMING transaction 445 is overdue (expected 2026-08-10T09:00:00.000Z)",
            "data": {
                "id": 445,
                "type": "INCOMING",
                "status": "PENDING",
                "expectedDate": "2026-08-10T09:00:00.000Z",
            },
            "referenceDate": _REFERENCE_DATE,
        },
        {
            "category": "PENDING_DOCUMENT_REVIEW",
            "severity": "INFO",
            "message": "Document review 501 (INCOMING) is awaiting a decision",
            "data": {
                "id": 501,
                "transactionType": "INCOMING",
                "status": "PENDING_REVIEW",
            },
            "referenceDate": _REFERENCE_DATE,
        },
        {
            "category": "RESTOCK_RECOMMENDATION",
            "severity": "WARNING",
            "message": "Product 8 in warehouse 2 needs 25 more units (purchase_required)",
            "data": {
                "productId": 8,
                "warehouseId": 2,
                "available": 5,
                "projectedAvailable": 5,
                "riskLevel": "AT_RISK",
                "projectedRiskLevel": "AT_RISK",
                "recommendedQuantity": 25,
                "reason": "purchase_required",
            },
            "referenceDate": _REFERENCE_DATE,
        },
        {
            "category": "TRANSFER_RECOMMENDATION",
            "severity": "WARNING",
            "message": "Transfer 15 units of product 9 from warehouse 3 to warehouse 2",
            "data": {
                "productId": 9,
                "fromWarehouseId": 3,
                "toWarehouseId": 2,
                "transferQuantity": 15,
                "fromWarehouseAvailableAfterTransfer": 35,
                "toWarehouseProjectedAvailableAfterTransfer": 20,
                "sourcePendingIncomingQuantity": 0,
                "sourceIsDeadStock": True,
                "destinationRiskLevel": "AT_RISK",
                "destinationAvgDailyConsumption": 2.5,
                "destinationDaysOfSupply": 2.0,
            },
            "referenceDate": _REFERENCE_DATE,
        },
    ]
    return [Alert.model_validate(raw) for raw in raw_alerts]
