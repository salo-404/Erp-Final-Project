"""Insights (and Procurement) tools for the Strands Agent.

Every function is decorated with @tool so it can be attached directly to a
Strands Agent. Stock insight tools call the real NestJS backend through the
shared BackendHttpClient. Tools not yet converted continue to use mock data.
All responses are validated against tools/schemas/insights_schema.py.

The agent that uses these tools must never compute the numbers itself - see
agents/insights_agent/prompts.py. These tools are the single source of truth
for every figure the agent reports.
"""

from __future__ import annotations

from typing import Optional

from strands import tool

from clients import BackendHttpClient
from tools.mocks import insights_mock_data as mocks
from tools.schemas.insights_schema import (
    AvailableStockResponse,
    ConsumptionAnomaliesResponse,
    DeadStockResponse,
    DraftPurchaseOrderResponse,
    ExpiryRiskResponse,
    LowStockResponse,
    OpenPurchaseOrdersResponse,
    ReorderQuantityResult,
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
def get_expiry_risk() -> dict:
    """Get products/batches approaching their expiry date, with a backend-calculated risk level.

    Returns:
        A dict with an `items` list carrying batchId, expiryDate,
        daysUntilExpiry, and riskLevel (LOW/MEDIUM/HIGH).
    """
    return ExpiryRiskResponse.model_validate(mocks.get_expiry_risk_mock()).model_dump(mode="json")


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
def calculate_reorder_quantity(product_id: int, warehouse_id: int) -> dict:
    """Get the backend-calculated recommended reorder quantity for one product at one warehouse.

    Args:
        product_id: The product's database ID.
        warehouse_id: The warehouse's database ID.

    Returns:
        A dict with the recommendedQuantity and the calculation `method`
        used by the backend (e.g. economic_order_quantity).
    """
    return ReorderQuantityResult.model_validate(
        mocks.calculate_reorder_quantity_mock(product_id, warehouse_id)
    ).model_dump(mode="json")


@tool
def compare_suppliers(product_id: int) -> dict:
    """Compare available suppliers for a product on cost, lead time, and reliability.

    Returns a backend-scored list plus a single recommendedSupplier. The
    recommended supplier is NOT necessarily the cheapest - it weighs lead
    time and reliability alongside cost. Always mention this trade-off when
    presenting the recommendation.

    Args:
        product_id: The product's database ID.

    Returns:
        A dict with a `scores` list (per-supplier unitCost, leadTimeDays,
        reliabilityScore, overallScore) and a `recommendedSupplier`.
    """
    return SupplierComparisonResponse.model_validate(
        mocks.compare_suppliers_mock(product_id)
    ).model_dump(mode="json")


@tool
def get_open_purchase_orders() -> dict:
    """Get all currently open (not fully received) purchase orders across all warehouses.

    Returns:
        A dict with an `orders` list carrying status
        (PENDING/APPROVED/IN_TRANSIT/PARTIALLY_RECEIVED), expectedDate,
        lineItemCount, and totalValue.
    """
    return OpenPurchaseOrdersResponse.model_validate(
        mocks.get_open_purchase_orders_mock()
    ).model_dump(mode="json")


@tool
def draft_purchase_order(product_id: int, warehouse_id: int, quantity: int) -> dict:
    """Draft a purchase order PROPOSAL for a product at a warehouse. Does NOT submit or execute anything.

    This only produces a proposal for a human to review and approve. It
    never creates a real purchase order, contacts a supplier, or commits
    spend.

    Args:
        product_id: The product's database ID to reorder.
        warehouse_id: The warehouse's database ID the stock should arrive at.
        quantity: The quantity to include on the draft order.

    Returns:
        A dict describing the draft order (supplier, line items, estimated
        total, estimated lead time). `isDraft` is always True.
    """
    return DraftPurchaseOrderResponse.model_validate(
        mocks.draft_purchase_order_mock(product_id, warehouse_id, quantity)
    ).model_dump(mode="json")
