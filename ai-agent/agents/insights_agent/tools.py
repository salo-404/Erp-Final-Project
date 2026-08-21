"""Insights (and Procurement) tools for the Strands Agent.

Every function is decorated with @tool so it can be attached directly to a
Strands Agent. The active tools call the real NestJS backend through the
shared BackendHttpClient and validate responses against the Pydantic schemas.

The agent that uses these tools must never compute the numbers itself - see
agents/insights_agent/prompts.py. These tools are the single source of truth
for every figure the agent reports.
"""

from __future__ import annotations

from typing import Optional

from strands import tool

from clients import BackendHttpClient
from tools.schemas.insights_schema import (
    AvailableStockResponse,
    ConsumptionAnomaliesResponse,
    DeadStockResponse,
    LowStockResponse,
    OpenPurchaseOrdersResponse,
    RestockRecommendationsResponse,
    StockoutRiskResponse,
    SupplierComparisonResponse,
    TransferRecommendationsResponse,
)


@tool
def get_available_stock(warehouse_id: int, product_id: int) -> dict:
    """Get current available stock for one product in one warehouse.

    Prefer this tool over restock recommendations when the question is
    whether a specific warehouse can fulfill demand for a specific product.
    The backend calculates available stock from on-hand stock minus ACTIVE
    reservations.

    Args:
        warehouse_id: Warehouse database ID.
        product_id: Product database ID.

    Returns:
        A dict with one `items` entry containing warehouse/product IDs plus
        backend-calculated onHand, reserved, and available quantities.
    """
    row = BackendHttpClient().get(
        f"/warehouse-inventory/available/{warehouse_id}/{product_id}"
    )
    return AvailableStockResponse.model_validate(
        {"items": [row]}
    ).model_dump(mode="json")


@tool
def get_low_stock_products(warehouse_id: int) -> dict:
    """Get products at or below their reorder threshold in one warehouse.

    Args:
        warehouse_id: Warehouse database ID.

    Returns:
        A dict with an `items` list preserving the backend's on-hand,
        reserved, available, and reorder-threshold evidence.
    """
    rows = BackendHttpClient().get(
        f"/warehouse-inventory/low-stock/{warehouse_id}"
    )
    items = [
        {
            "inventoryId": row["id"],
            "productId": row["productId"],
            "productName": row["product"]["name"],
            "warehouseId": row["warehouseId"],
            "onHand": row["onHand"],
            "reserved": row["reserved"],
            "available": row["available"],
            "reorderThreshold": row["reorderThreshold"],
        }
        for row in rows
    ]
    return LowStockResponse.model_validate({"items": items}).model_dump(mode="json")


@tool
def get_stockout_risk(
    consumption_window_days: Optional[int] = None,
    reference_date: Optional[str] = None,
) -> dict:
    """Get backend-calculated stockout risk and supporting inventory evidence.

    Args:
        consumption_window_days: Optional consumption lookback window.
        reference_date: Optional ISO date/time used as the calculation reference.

    Returns:
        A dict with an `items` list carrying availability, pending incoming,
        projected availability, risk levels, consumption, and days of supply.
    """
    rows = BackendHttpClient().get(
        "/stock-insights/stockout-risk",
        query={
            "consumptionWindowDays": consumption_window_days,
            "referenceDate": reference_date,
        },
    )
    return StockoutRiskResponse.model_validate({"items": rows}).model_dump(mode="json")


@tool
def get_restock_recommendations(
    consumption_window_days: Optional[int] = None,
    reference_date: Optional[str] = None,
) -> dict:
    """Get actionable backend-generated restock recommendations and evidence.

    Args:
        consumption_window_days: Optional consumption lookback window.
        reference_date: Optional ISO date/time used as the calculation reference.

    Returns:
        A dict with a `recommendations` list. The backend returns only rows
        that still need action, with `recommendedQuantity`, risk evidence,
        and a reason of `transfer_available` or `purchase_required`.
    """
    rows = BackendHttpClient().get(
        "/stock-insights/restock-recommendations",
        query={
            "consumptionWindowDays": consumption_window_days,
            "referenceDate": reference_date,
        },
    )
    return RestockRecommendationsResponse.model_validate(
        {"recommendations": rows}
    ).model_dump(mode="json")


@tool
def get_transfer_recommendations(
    consumption_window_days: Optional[int] = None,
    reference_date: Optional[str] = None,
) -> dict:
    """Get backend-recommended stock transfers and supporting evidence.

    Args:
        consumption_window_days: Optional consumption lookback window.
        reference_date: Optional ISO date/time used as the calculation reference.

    Returns:
        A dict with a `recommendations` list containing source/destination
        IDs, transfer quantity, post-transfer availability, destination
        risk, consumption, and donor dead-stock context.
    """
    rows = BackendHttpClient().get(
        "/stock-insights/transfer-recommendations",
        query={
            "consumptionWindowDays": consumption_window_days,
            "referenceDate": reference_date,
        },
    )
    return TransferRecommendationsResponse.model_validate(
        {"recommendations": rows}
    ).model_dump(mode="json")


@tool
def analyze_dead_stock(
    inactivity_days: Optional[int] = None,
    reference_date: Optional[str] = None,
) -> dict:
    """Identify stock with no recent outgoing customer movement.

    Args:
        inactivity_days: Optional outgoing-movement inactivity threshold.
        reference_date: Optional ISO date/time used as the calculation reference.

    Returns:
        A dict with an `items` list carrying on-hand stock plus the most
        recent general and outgoing movement dates/day counts.
    """
    rows = BackendHttpClient().get(
        "/stock-insights/dead-stock",
        query={
            "inactivityDays": inactivity_days,
            "referenceDate": reference_date,
        },
    )
    return DeadStockResponse.model_validate({"items": rows}).model_dump(mode="json")


@tool
def get_consumption_anomalies(
    window_days: Optional[int] = None,
    threshold_percent: Optional[int] = None,
    reference_date: Optional[str] = None,
    minimum_quantity_change: Optional[int] = None,
) -> dict:
    """Get product-level changes between recent and baseline consumption.

    Args:
        window_days: Optional length of each comparison window.
        threshold_percent: Optional minimum percentage change to report.
        reference_date: Optional ISO date/time used as the calculation reference.
        minimum_quantity_change: Optional absolute quantity-change floor.

    Returns:
        A dict with an `anomalies` list carrying recent quantity, baseline
        quantity, percentage change, and INCREASE/DECREASE direction. The
        backend aggregates this analysis by product across warehouses.
    """
    rows = BackendHttpClient().get(
        "/stock-insights/consumption-anomalies",
        query={
            "windowDays": window_days,
            "thresholdPercent": threshold_percent,
            "referenceDate": reference_date,
            "minimumQuantityChange": minimum_quantity_change,
        },
    )
    return ConsumptionAnomaliesResponse.model_validate(
        {"anomalies": rows}
    ).model_dump(mode="json")


@tool
def compare_suppliers(product_id: int) -> dict:
    """Get the backend-ranked suppliers for a product with scoring evidence.

    NestJS calculates every metric, normalized component score, composite
    score, insufficient-data decision, and rank. Suppliers without enough
    evidence remain present with null score/rank and explanatory reasons.

    Args:
        product_id: The product's database ID.

    Returns:
        A dict containing `productId` and the backend's ranked `suppliers`.
    """
    suppliers = BackendHttpClient().get(
        "/supplier-intelligence/rank",
        query={"productId": product_id},
    )
    return SupplierComparisonResponse.model_validate(
        {"productId": product_id, "suppliers": suppliers}
    ).model_dump(mode="json")


@tool
def get_open_purchase_orders(
    destination_warehouse_id: Optional[int] = None,
    supplier_id: Optional[int] = None,
    expected_date_from: Optional[str] = None,
    expected_date_to: Optional[str] = None,
) -> dict:
    """Get PENDING INCOMING inventory transactions representing open purchases.

    Args:
        destination_warehouse_id: Optional destination warehouse filter.
        supplier_id: Optional supplier filter.
        expected_date_from: Optional inclusive expected-date lower bound.
        expected_date_to: Optional inclusive expected-date upper bound.

    Returns:
        A dict with real `transactions`, including supplier/destination IDs,
        expected dates, document URLs, and priced line items where returned.
    """
    rows = BackendHttpClient().get(
        "/inventory-transactions",
        query={
            "type": "INCOMING",
            "status": "PENDING",
            "destinationWarehouseId": destination_warehouse_id,
            "supplierId": supplier_id,
            "expectedDateFrom": expected_date_from,
            "expectedDateTo": expected_date_to,
        },
    )
    transactions = [
        {
            "transactionId": row["id"],
            "type": row["type"],
            "status": row["status"],
            "supplierId": row.get("supplierId"),
            "destinationWarehouseId": row.get("destinationWarehouseId"),
            "expectedDate": row.get("expectedDate"),
            "actualDate": row.get("actualDate"),
            "deliveryCountry": row.get("deliveryCountry"),
            "deliveryRegion": row.get("deliveryRegion"),
            "deliveryAddress": row.get("deliveryAddress"),
            "documentUrl": row.get("documentUrl"),
            "createdAt": row["createdAt"],
            "updatedAt": row["updatedAt"],
            "items": [
                {
                    "itemId": item["id"],
                    "productId": item["productId"],
                    "quantity": item["quantity"],
                    "price": item.get("price"),
                }
                for item in row["items"]
            ],
        }
        for row in rows
    ]
    return OpenPurchaseOrdersResponse.model_validate(
        {"transactions": transactions}
    ).model_dump(mode="json")

