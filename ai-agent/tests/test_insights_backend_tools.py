"""Unit tests for Insights tools connected to StockInsightsController."""

from __future__ import annotations

from unittest.mock import Mock, patch

from agents.insights_agent.tools import (
    analyze_dead_stock,
    compare_suppliers,
    get_available_stock,
    get_consumption_anomalies,
    get_low_stock_products,
    get_open_purchase_orders,
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


def test_compare_suppliers_preserves_backend_ranking_and_insufficient_data() -> None:
    backend_ranked = [
        {
            "supplierId": 5,
            "supplierName": "Reliable Supply",
            "productId": 42,
            "totalTransactions": 6,
            "completedTransactions": 5,
            "cancelledTransactions": 1,
            "cancellationRate": 1 / 6,
            "averagePrice": 18.25,
            "pricedItemCount": 6,
            "onTimeDeliveryRate": 0.8,
            "evaluatedForOnTimeCount": 5,
            "purchaseFrequency": 2.4,
            "firstPurchaseDate": "2026-01-01T00:00:00.000Z",
            "lastPurchaseDate": "2026-06-01T00:00:00.000Z",
            "rank": 1,
            "score": 83.75,
            "insufficientData": False,
            "insufficientDataReasons": [],
            "componentScores": {
                "price": 75.0,
                "onTimeDelivery": 90.0,
                "cancellationPerformance": 80.0,
                "productSupplyHistory": 100.0,
            },
        },
        {
            "supplierId": 8,
            "supplierName": "New Supplier",
            "productId": 42,
            "totalTransactions": 1,
            "completedTransactions": 1,
            "cancelledTransactions": 0,
            "cancellationRate": 0.0,
            "averagePrice": 17.0,
            "pricedItemCount": 1,
            "onTimeDeliveryRate": None,
            "evaluatedForOnTimeCount": 0,
            "purchaseFrequency": 30.0,
            "firstPurchaseDate": "2026-07-01T00:00:00.000Z",
            "lastPurchaseDate": "2026-07-01T00:00:00.000Z",
            "rank": None,
            "score": None,
            "insufficientData": True,
            "insufficientDataReasons": [
                "onTimeDeliveryRate unavailable",
                "productSupplyHistory unavailable",
            ],
            "componentScores": {
                "price": 100.0,
                "onTimeDelivery": None,
                "cancellationPerformance": 100.0,
                "productSupplyHistory": None,
            },
        },
    ]
    constructor, client = client_returning(backend_ranked)

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = compare_suppliers(42)

    client.get.assert_called_once_with(
        "/supplier-intelligence/rank",
        query={"productId": 42},
    )
    assert result["productId"] == 42
    assert result["suppliers"][0]["rank"] == 1
    assert result["suppliers"][0]["score"] == 83.75
    insufficient = result["suppliers"][1]
    assert insufficient["insufficientData"] is True
    assert insufficient["rank"] is None
    assert insufficient["score"] is None
    assert insufficient["insufficientDataReasons"] == [
        "onTimeDeliveryRate unavailable",
        "productSupplyHistory unavailable",
    ]
    assert insufficient["componentScores"]["onTimeDelivery"] is None
    assert "overallScore" not in result["suppliers"][0]
    assert "recommendedSupplier" not in result


def test_get_open_purchase_orders_filters_pending_incoming_and_preserves_evidence() -> None:
    constructor, client = client_returning(
        [
            {
                "id": 91,
                "type": "INCOMING",
                "status": "PENDING",
                "sourceWarehouseId": None,
                "destinationWarehouseId": 2,
                "supplierId": 5,
                "deliveryCountry": "Lebanon",
                "deliveryRegion": "Beirut",
                "deliveryAddress": "Port district",
                "expectedDate": "2026-09-01T00:00:00.000Z",
                "actualDate": None,
                "partyName": None,
                "documentUrl": "https://documents.example/incoming-91.pdf",
                "createdAt": "2026-08-20T10:00:00.000Z",
                "updatedAt": "2026-08-21T10:00:00.000Z",
                "items": [
                    {
                        "id": 301,
                        "transactionId": 91,
                        "productId": 42,
                        "quantity": 25,
                        "price": "18.25",
                    }
                ],
            }
        ]
    )

    with patch("agents.insights_agent.tools.BackendHttpClient", constructor):
        result = get_open_purchase_orders(
            destination_warehouse_id=2,
            supplier_id=5,
            expected_date_from="2026-08-01T00:00:00Z",
            expected_date_to="2026-09-30T23:59:59Z",
        )

    client.get.assert_called_once_with(
        "/inventory-transactions",
        query={
            "type": "INCOMING",
            "status": "PENDING",
            "destinationWarehouseId": 2,
            "supplierId": 5,
            "expectedDateFrom": "2026-08-01T00:00:00Z",
            "expectedDateTo": "2026-09-30T23:59:59Z",
        },
    )
    transaction = result["transactions"][0]
    assert transaction["transactionId"] == 91
    assert transaction["type"] == "INCOMING"
    assert transaction["status"] == "PENDING"
    assert transaction["supplierId"] == 5
    assert transaction["destinationWarehouseId"] == 2
    assert transaction["documentUrl"].endswith("incoming-91.pdf")
    assert transaction["items"] == [
        {
            "itemId": 301,
            "productId": 42,
            "quantity": 25,
            "price": "18.25",
        }
    ]
    assert "purchaseOrderId" not in transaction
    assert "approvalState" not in transaction
    assert "totalValue" not in transaction


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
