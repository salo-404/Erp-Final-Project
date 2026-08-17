"""Insights (and Procurement) tools for the Strands Agent.

Every function is decorated with @tool so it can be attached directly to a
Strands Agent. Bodies are MOCKED - they call into tools/mocks/insights_mock_data.py
and validate the result against tools/schemas/insights_schema.py before
returning it as a plain dict. No real backend/database call happens here.

The agent that uses these tools must never compute the numbers itself - see
agents/insights_agent/prompts.py. These tools are the single source of truth
for every figure the agent reports.
"""

from __future__ import annotations

from typing import Optional

from strands import tool

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
def get_available_stock(product_ids: Optional[list[int]] = None) -> dict:
    """Get current available stock (on hand minus reserved), optionally filtered to specific products.

    Pass product_ids to check availability for exact products you already
    know about - e.g. the matched productIds for a specific order's line
    items (from the Document agent's extraction) - rather than pulling
    every product's stock. Prefer this targeted form over
    get_restock_recommendations() when the question is "can we fulfill
    THIS order" rather than "what should we reorder in general" - it
    directly answers whether on-hand stock covers what was actually
    requested, for exactly those items.

    Args:
        product_ids: Optional list of specific product database IDs to
            check. Omit to get stock for every product across every
            warehouse.

    Returns:
        A dict with an `items` list of per-product/per-warehouse stock levels
        (onHand, reserved, available) and an `asOf` timestamp.
    """
    return AvailableStockResponse.model_validate(
        mocks.get_available_stock_mock(product_ids=product_ids)
    ).model_dump(mode="json")


@tool
def get_low_stock_products() -> dict:
    """Get products whose on-hand quantity has fallen below their reorder threshold.

    Returns:
        A dict with an `items` list of low-stock products (onHand,
        reorderThreshold, deficit) and an `asOf` timestamp.
    """
    return LowStockResponse.model_validate(mocks.get_low_stock_products_mock()).model_dump(mode="json")


@tool
def get_stockout_risk() -> dict:
    """Get backend-calculated stockout risk levels and projected stockout dates for at-risk products.

    Returns:
        A dict with an `items` list, each carrying a `riskLevel`
        (LOW/MEDIUM/HIGH/CRITICAL), a `riskScore` (0-1), and a
        `projectedStockoutDate` when available.
    """
    return StockoutRiskResponse.model_validate(mocks.get_stockout_risk_mock()).model_dump(mode="json")


@tool
def get_restock_recommendations() -> dict:
    """Get backend-generated restock recommendations, including whether a reorder is needed and why.

    Returns:
        A dict with a `recommendations` list. Each item has `needsReorder`
        (bool), a `reason` enum (BELOW_THRESHOLD, STOCKOUT_PREDICTED,
        SEASONAL_DEMAND, SUPPLIER_LEAD_TIME_RISK), a recommended `quantity`,
        and a `candidate` supplier for the reorder.
    """
    return RestockRecommendationsResponse.model_validate(
        mocks.get_restock_recommendations_mock()
    ).model_dump(mode="json")


@tool
def get_transfer_recommendations() -> dict:
    """Get backend-recommended stock transfers between warehouses to balance surplus and shortage.

    Returns:
        A dict with a `recommendations` list of source/destination
        warehouse pairs, the product, quantity, and reason for the
        suggested transfer.
    """
    return TransferRecommendationsResponse.model_validate(
        mocks.get_transfer_recommendations_mock()
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
def analyze_dead_stock() -> dict:
    """Identify dead stock - products with no recent movement that are tying up capital.

    Returns:
        A dict with an `items` list carrying daysSinceLastMovement, a
        `reason` enum (NO_MOVEMENT, OVERSTOCKED, DISCONTINUED_CANDIDATE),
        and the backend-calculated tiedUpCapital value.
    """
    return DeadStockResponse.model_validate(mocks.analyze_dead_stock_mock()).model_dump(mode="json")


@tool
def get_consumption_anomalies() -> dict:
    """Get products whose recent consumption pattern deviates from the backend-calculated expected baseline.

    Returns:
        A dict with an `anomalies` list, each carrying an `anomalyType`
        (SPIKE, DROP, IRREGULAR_PATTERN), the observed vs. expected
        quantity, and the deviation percentage.
    """
    return ConsumptionAnomaliesResponse.model_validate(
        mocks.get_consumption_anomalies_mock()
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
