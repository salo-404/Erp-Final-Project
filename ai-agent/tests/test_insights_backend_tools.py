"""Unit tests for Insights tools connected to StockInsightsController."""

from __future__ import annotations

from unittest.mock import Mock, patch

from agents.insights_agent.tools import (
    analyze_dead_stock,
    get_available_stock,
    get_consumption_anomalies,
    get_low_stock_products,
    get_restock_recommendations,
    get_stockout_risk,
    get_transfer_recommendations,
)


def client_returning(response: object) -> tuple[Mock, Mock]:
    client = Mock()
    client.get.return_value = response
    constructor = Mock(return_value=client)
    return constructor, client


def test_get_available_stock_calls_exact_backend_operation() -> None:
    constructor, client = client_returning(
        {
            "warehouseId": 2,
            "productId": 1,
            "onHand": 20,
            "reserved": 6,
            "available": 14,
        }
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = get_available_stock(2, 1)

    client.get.assert_called_once_with(
        "/warehouse-inventory/available/2/1"
    )
    assert result == {
        "items": [
            {
                "productId": 1,
                "warehouseId": 2,
                "onHand": 20,
                "reserved": 6,
                "available": 14,
            }
        ]
    }


def test_get_low_stock_products_preserves_backend_threshold_evidence() -> None:
    constructor, client = client_returning(
        [
            {
                "id": 9,
                "productId": 1,
                "warehouseId": 2,
                "onHand": 20,
                "reorderThreshold": 15,
                "reserved": 6,
                "available": 14,
                "product": {
                    "id": 1,
                    "name": "Widget",
                    "category": "Parts",
                    "description": None,
                    "isActive": True,
                    "createdAt": "2026-08-01T00:00:00.000Z",
                },
            }
        ]
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = get_low_stock_products(2)

    client.get.assert_called_once_with("/warehouse-inventory/low-stock/2")
    assert result == {
        "items": [
            {
                "inventoryId": 9,
                "productId": 1,
                "productName": "Widget",
                "warehouseId": 2,
                "onHand": 20,
                "reserved": 6,
                "available": 14,
                "reorderThreshold": 15,
            }
        ]
    }
    assert "deficit" not in result["items"][0]


def test_get_stockout_risk_calls_backend_and_preserves_evidence() -> None:
    constructor, client = client_returning(
        [
            {
                "productId": 1,
                "warehouseId": 2,
                "onHand": 10,
                "activeReserved": 3,
                "available": 7,
                "reorderThreshold": 12,
                "riskLevel": "AT_RISK",
                "pendingIncomingQuantity": 4,
                "projectedAvailable": 11,
                "projectedRiskLevel": "AT_RISK",
                "avgDailyConsumption": 2.5,
                "daysOfSupply": 2.8,
                "predictedStockoutDate": "2026-08-24T00:00:00.000Z",
            }
        ]
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = get_stockout_risk(30, "2026-08-21T00:00:00Z")

    client.get.assert_called_once_with(
        "/stock-insights/stockout-risk",
        query={
            "consumptionWindowDays": 30,
            "referenceDate": "2026-08-21T00:00:00Z",
        },
    )
    assert result["items"][0]["riskLevel"] == "AT_RISK"
    assert result["items"][0]["activeReserved"] == 3
    assert "riskScore" not in result["items"][0]


def test_get_restock_recommendations_uses_real_backend_contract() -> None:
    constructor, client = client_returning(
        [
            {
                "productId": 1,
                "warehouseId": 2,
                "available": 7,
                "pendingIncomingQuantity": 0,
                "projectedAvailable": 7,
                "reorderThreshold": 12,
                "riskLevel": "AT_RISK",
                "projectedRiskLevel": "AT_RISK",
                "recommendedQuantity": 5,
                "avgDailyConsumption": 2.5,
                "daysOfSupply": 2.8,
                "reason": "purchase_required",
                "explanation": "No transfer source can cover the shortage.",
            }
        ]
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = get_restock_recommendations()

    client.get.assert_called_once_with(
        "/stock-insights/restock-recommendations",
        query={"consumptionWindowDays": None, "referenceDate": None},
    )
    recommendation = result["recommendations"][0]
    assert recommendation["recommendedQuantity"] == 5
    assert recommendation["reason"] == "purchase_required"
    assert "candidate" not in recommendation


def test_get_transfer_recommendations_uses_real_backend_contract() -> None:
    constructor, client = client_returning(
        [
            {
                "productId": 1,
                "fromWarehouseId": 3,
                "toWarehouseId": 2,
                "transferQuantity": 5,
                "fromWarehouseAvailableAfterTransfer": 20,
                "toWarehouseProjectedAvailableAfterTransfer": 12,
                "sourcePendingIncomingQuantity": 0,
                "sourceIsDeadStock": True,
                "destinationRiskLevel": "AT_RISK",
                "destinationAvgDailyConsumption": 2.5,
                "destinationDaysOfSupply": 2.8,
            }
        ]
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = get_transfer_recommendations(14)

    client.get.assert_called_once_with(
        "/stock-insights/transfer-recommendations",
        query={"consumptionWindowDays": 14, "referenceDate": None},
    )
    recommendation = result["recommendations"][0]
    assert recommendation["transferQuantity"] == 5
    assert recommendation["sourceIsDeadStock"] is True


def test_analyze_dead_stock_calls_backend_with_supported_filters() -> None:
    constructor, client = client_returning(
        [
            {
                "productId": 1,
                "warehouseId": 2,
                "onHand": 10,
                "lastMovementAt": "2026-06-01T00:00:00.000Z",
                "daysSinceLastMovement": 81,
                "lastOutgoingMovementAt": None,
                "daysSinceLastOutgoingMovement": None,
            }
        ]
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = analyze_dead_stock(60, "2026-08-21T00:00:00Z")

    client.get.assert_called_once_with(
        "/stock-insights/dead-stock",
        query={
            "inactivityDays": 60,
            "referenceDate": "2026-08-21T00:00:00Z",
        },
    )
    item = result["items"][0]
    assert item["daysSinceLastMovement"] == 81
    assert item["lastOutgoingMovementAt"] is None
    assert "tiedUpCapital" not in item


def test_get_consumption_anomalies_passes_filters_and_preserves_null_percent() -> None:
    constructor, client = client_returning(
        [
            {
                "productId": 1,
                "recentQuantity": 12,
                "baselineQuantity": 0,
                "percentChange": None,
                "direction": "INCREASE",
            }
        ]
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = get_consumption_anomalies(
            30,
            50,
            "2026-08-21T00:00:00Z",
            5,
        )

    client.get.assert_called_once_with(
        "/stock-insights/consumption-anomalies",
        query={
            "windowDays": 30,
            "thresholdPercent": 50,
            "referenceDate": "2026-08-21T00:00:00Z",
            "minimumQuantityChange": 5,
        },
    )
    anomaly = result["anomalies"][0]
    assert anomaly["direction"] == "INCREASE"
    assert anomaly["percentChange"] is None
    assert "warehouseId" not in anomaly
