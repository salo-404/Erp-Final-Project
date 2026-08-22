"""Insights (and Procurement) tools for the Strands Agent.

Every function is decorated with @tool so it can be attached directly to a
Strands Agent. Every active tool in this file is wired to the real backend
via get_backend_client() (see backend_client.py). Every real backend call's typed errors (Unauthorized,
Forbidden, NotFound, ValidationError, Conflict, ServiceUnavailable - see
backend_client.py) propagate uncaught, same convention as every other
wired tool in this codebase.

The agent that uses these tools must never compute the numbers itself - see
agents/insights_agent/prompts.py. These tools are the single source of truth
for every figure the agent reports.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from strands import tool

from backend_client import NotFound, get_backend_client
from tools.schemas.insights_schema import (
    AvailableStockResponse,
    ConsumptionAnomaliesResponse,
    DeadStockResponse,
    LowStockResponse,
    OpenPurchaseOrdersResponse,
    RecommendDeadStockTransferResponse,
    ReorderQuantityResult,
    RestockRecommendationsResponse,
    StockoutRiskResponse,
    SupplierComparisonResponse,
    TransferRecommendationsResponse,
)

# How far back recommend_dead_stock_transfer() looks for OUTGOING activity
# at OTHER warehouses before treating one as a viable transfer destination.
_DEAD_STOCK_TRANSFER_LOOKBACK_DAYS = 60


@tool
async def get_available_stock(product_ids: list[int], warehouse_id: Optional[int] = None) -> dict:
    """Get current available stock (on hand minus reserved) for specific products.

    product_ids is REQUIRED - there is no "every product, every warehouse"
    mode. The real backend has no endpoint that returns computed available
    stock in bulk; supporting an unfiltered call would mean an unbounded
    number of HTTP requests (enumerate every warehouse, every product held
    in each, then call the per-pair availability endpoint for every row).
    Always pass the exact product IDs you need - e.g. the matched
    productIds for a specific order's line items (from the Document
    agent's extraction). Prefer this targeted form over
    get_restock_recommendations() when the question is "can we fulfill
    THIS order" rather than "what should we reorder in general" - it
    directly answers whether on-hand stock covers what was actually
    requested, for exactly those items.

    Pass warehouse_id to check a single specific warehouse (one backend
    call per product). Omit it to check every warehouse CURRENTLY stocking
    each product (a discovery call per product, then one availability call
    per warehouse it's actually held in - never every warehouse that
    exists).

    Args:
        product_ids: Required, non-empty list of product database IDs to check.
        warehouse_id: Optional warehouse database ID to restrict the check
            to. When given and that exact (product, warehouse) pair has
            never been stocked there, this is reported as a real
            "not stocked here" answer (onHand/reserved/available all 0),
            not an error - the backend has no way to distinguish "never
            stocked here" from "warehouse_id doesn't exist" (both produce
            an identical response), so treat a 0 result with an unfamiliar
            warehouse_id as a hint to double-check the ID.

    Returns:
        A dict with an `items` list of per-product/per-warehouse stock
        levels (productName, warehouseId, warehouseName, onHand, reserved,
        available) and an `asOf` timestamp. productName/warehouseName are
        None only when the id refers to an inactive/deleted product or
        warehouse (the backend's catalog lookups only return active ones) -
        the stock numbers themselves are still real in that case, never
        omitted.

    Raises:
        ValueError if product_ids is empty.
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) for any real backend
        failure OTHER than the specific "no inventory row for this
        (product, warehouse_id) pair" case above (which is handled as a
        zero result, not an error, only when warehouse_id was explicitly
        given). Deliberately NOT caught/swallowed otherwise - same pattern
        as every other wired tool in this file.
    """
    if not product_ids:
        raise ValueError("product_ids must not be empty")

    client = get_backend_client()

    products = await client.get("/products")
    product_names = {product["id"]: product["name"] for product in products}

    items = []

    if warehouse_id is not None:
        warehouses = await client.get("/warehouses")
        warehouse_name = {warehouse["id"]: warehouse["name"] for warehouse in warehouses}.get(warehouse_id)

        for product_id in product_ids:
            try:
                entry = await client.get(f"/warehouse-inventory/available/{warehouse_id}/{product_id}")
            except NotFound:
                # Genuinely "not stocked here" - a real answer, not a system
                # error. See the docstring for why this can't be
                # distinguished from a nonexistent warehouse_id.
                items.append(
                    {
                        "productId": product_id,
                        "productName": product_names.get(product_id),
                        "warehouseId": warehouse_id,
                        "warehouseName": warehouse_name,
                        "onHand": 0,
                        "reserved": 0,
                        "available": 0,
                    }
                )
                continue

            items.append(
                {
                    "productId": entry["productId"],
                    "productName": product_names.get(entry["productId"]),
                    "warehouseId": entry["warehouseId"],
                    "warehouseName": warehouse_name,
                    "onHand": entry["onHand"],
                    "reserved": entry["reserved"],
                    "available": entry["available"],
                }
            )
    else:
        for product_id in product_ids:
            inventory_rows = await client.get(f"/warehouse-inventory/product/{product_id}")
            for row in inventory_rows:
                entry = await client.get(f"/warehouse-inventory/available/{row['warehouseId']}/{product_id}")
                items.append(
                    {
                        "productId": entry["productId"],
                        "productName": product_names.get(entry["productId"]),
                        "warehouseId": entry["warehouseId"],
                        "warehouseName": row["warehouse"]["name"],
                        "onHand": entry["onHand"],
                        "reserved": entry["reserved"],
                        "available": entry["available"],
                    }
                )

    return AvailableStockResponse.model_validate(
        {"items": items, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


@tool
async def get_low_stock_products(warehouse_id: Optional[int] = None) -> dict:
    """Get products whose available quantity has fallen to or below their reorder threshold.

    Pass warehouse_id to check a single warehouse (one backend call, plus
    one shared GET /warehouses call for the warehouse's name). Omit it to
    check every currently ACTIVE warehouse - real scale is small (3 active
    warehouses in current data), so this is one GET /warehouses discovery
    call plus one low-stock call per active warehouse, never expensive.

    Args:
        warehouse_id: Optional warehouse database ID to restrict the check to.

    Returns:
        A dict with an `items` list. Each item carries onHand,
        reorderThreshold, reserved, available (the backend's real
        available <= reorderThreshold comparison - not raw onHand), and
        `deficit` (max(reorderThreshold - available, 0), computed in this
        tool's own code from those real fields, not a backend-provided
        number). warehouseName is None only for an explicitly-requested
        inactive warehouse_id (GET /warehouses only returns active ones,
        but the low-stock query itself has no isActive filter, so this
        combination can genuinely occur).

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if a backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()

    warehouses = await client.get("/warehouses")
    warehouse_names = {warehouse["id"]: warehouse["name"] for warehouse in warehouses}
    warehouse_ids = [warehouse_id] if warehouse_id is not None else list(warehouse_names.keys())

    items = []
    for current_warehouse_id in warehouse_ids:
        rows = await client.get(f"/warehouse-inventory/low-stock/{current_warehouse_id}")
        for row in rows:
            available = row["available"]
            reorder_threshold = row["reorderThreshold"]
            items.append(
                {
                    "productId": row["productId"],
                    "productName": row["product"]["name"],
                    "warehouseId": row["warehouseId"],
                    "warehouseName": warehouse_names.get(row["warehouseId"]),
                    "onHand": row["onHand"],
                    "reorderThreshold": reorder_threshold,
                    "reserved": row["reserved"],
                    "available": available,
                    "deficit": max(reorder_threshold - available, 0),
                }
            )

    return LowStockResponse.model_validate(
        {"items": items, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


@tool
async def get_stockout_risk() -> dict:
    """Get backend-calculated stockout risk levels and predicted stockout dates for at-risk products.

    Returns:
        A dict with an `items` list, each carrying a `riskLevel`
        (OK/AT_RISK/OUT_OF_STOCK - a direct pass-through of the backend's
        own value, no remapping), a `predictedStockoutDate` when
        available, and `averageDailyConsumption`.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this codebase: Strands turns a raised
        exception into a proper tool-error result, and the agent must
        then genuinely retry or honestly report the failure, never
        fabricate a result.
    """
    client = get_backend_client()
    entries = await client.get("/stock-insights/stockout-risk")

    items = [
        {
            "productId": entry["productId"],
            "warehouseId": entry["warehouseId"],
            "riskLevel": entry["riskLevel"],
            "predictedStockoutDate": entry["predictedStockoutDate"],
            "averageDailyConsumption": entry["avgDailyConsumption"],
        }
        for entry in entries
    ]

    return StockoutRiskResponse.model_validate(
        {"items": items, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


@tool
async def get_restock_recommendations() -> dict:
    """Get backend-generated restock recommendations, including why each one exists.

    Returns:
        A dict with a `recommendations` list. Each item has a
        `recommendedQuantity`, a `reason` (transfer_available/
        purchase_required - a direct pass-through of the backend's own
        2-value enum, no remapping), and a backend-generated `explanation`
        sentence. No supplier candidate is included - this endpoint
        doesn't recommend one; use compare_suppliers() separately for that.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()
    entries = await client.get("/stock-insights/restock-recommendations")

    recommendations = [
        {
            "productId": entry["productId"],
            "warehouseId": entry["warehouseId"],
            "recommendedQuantity": entry["recommendedQuantity"],
            "reason": entry["reason"],
            "explanation": entry["explanation"],
        }
        for entry in entries
    ]

    return RestockRecommendationsResponse.model_validate(
        {"recommendations": recommendations, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


def _build_transfer_recommendation_reason(
    destination_risk_level: str,
    destination_days_of_supply: Optional[float],
    source_is_dead_stock: bool,
) -> str:
    """Deterministic reason string built entirely from real backend fields already on the entry.

    No reason string exists on the real TransferRecommendation - this
    generates one in plain Python from data already fetched, never from
    the model (see prompts.py rule 1: the agent interprets, it never
    invents numbers or claims it can't back with a real value).
    """
    urgency = {
        "OUT_OF_STOCK": "is out of stock",
        "AT_RISK": "is at risk of stocking out",
        "OK": "has adequate stock",
    }.get(destination_risk_level, "has an uncertain stock position")

    supply_clause = (
        f", with about {destination_days_of_supply:.1f} days of supply remaining"
        if destination_days_of_supply is not None
        else ""
    )

    source_clause = (
        " The source warehouse's surplus is also flagged as slow-moving stock, "
        "so donating it carries little opportunity cost."
        if source_is_dead_stock
        else ""
    )

    return f"Destination warehouse {urgency}{supply_clause}.{source_clause}"


@tool
async def get_transfer_recommendations() -> dict:
    """Get backend-recommended stock transfers between warehouses to balance surplus and shortage.

    Returns:
        A dict with a `recommendations` list of source/destination
        warehouse pairs, the product, `quantity`, and a `reason` string
        the AI layer builds deterministically from real backend fields
        (destinationRiskLevel, destinationDaysOfSupply, sourceIsDeadStock)
        - never model-generated.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()
    entries = await client.get("/stock-insights/transfer-recommendations")

    recommendations = [
        {
            "productId": entry["productId"],
            "sourceWarehouseId": entry["fromWarehouseId"],
            "destinationWarehouseId": entry["toWarehouseId"],
            "quantity": entry["transferQuantity"],
            "reason": _build_transfer_recommendation_reason(
                destination_risk_level=entry["destinationRiskLevel"],
                destination_days_of_supply=entry["destinationDaysOfSupply"],
                source_is_dead_stock=entry["sourceIsDeadStock"],
            ),
        }
        for entry in entries
    ]

    return TransferRecommendationsResponse.model_validate(
        {"recommendations": recommendations, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


@tool
async def analyze_dead_stock() -> dict:
    """Identify dead stock - products with no recent OUTGOING movement, sitting on on-hand stock.

    Returns:
        A dict with an `items` list. Each item carries onHand plus two
        separate movement signals: lastOutgoingMovementAt/
        daysSinceLastOutgoingMovement (OUTGOING only - true customer
        consumption; THIS is what actually determines dead-stock status),
        and lastMovementAt/daysSinceLastMovement (any movement type,
        including internal transfers/restocks/adjustments -
        informational only, does not by itself indicate the stock is
        moving to customers). All four are null when this product/
        warehouse pair has never had a movement of that type at all - not
        just "a long time ago". No `reason` category or `tiedUpCapital`
        cost estimate is included - the backend doesn't calculate either,
        and this tool never fabricates a number or category it didn't get
        from a real source.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        recommend_dead_stock_transfer() and get_stockout_risk() above.
    """
    client = get_backend_client()
    entries = await client.get("/stock-insights/dead-stock")

    items = [
        {
            "productId": entry["productId"],
            "warehouseId": entry["warehouseId"],
            "onHand": entry["onHand"],
            "lastMovementAt": entry["lastMovementAt"],
            "daysSinceLastMovement": entry["daysSinceLastMovement"],
            "lastOutgoingMovementAt": entry["lastOutgoingMovementAt"],
            "daysSinceLastOutgoingMovement": entry["daysSinceLastOutgoingMovement"],
        }
        for entry in entries
    ]

    return DeadStockResponse.model_validate(
        {"items": items, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


@tool
async def get_consumption_anomalies() -> dict:
    """Get product/warehouse pairs whose recent OUTGOING consumption deviates sharply from their own baseline.

    Backend compares each (product, warehouse) pair's consumption in the
    most recent window against the equal-length window before it and flags
    pairs whose change exceeds a threshold. Evaluated PER WAREHOUSE, not
    summed across a product's warehouses - a spike at one warehouse and a
    slump at another are reported as two separate anomalies rather than
    netting out and hiding both.

    Returns:
        A dict with an `anomalies` list. Each item carries `warehouseId`,
        `recentQuantity`, `baselineQuantity`, a `direction` (INCREASE/
        DECREASE - a direct pass-through of the backend's own value, no
        remapping), and `percentChange` (null when baselineQuantity is 0 -
        new consumption appearing from nothing, itself the anomaly).

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()
    entries = await client.get("/stock-insights/consumption-anomalies")

    anomalies = [
        {
            "productId": entry["productId"],
            "warehouseId": entry["warehouseId"],
            "recentQuantity": entry["recentQuantity"],
            "baselineQuantity": entry["baselineQuantity"],
            "percentChange": entry["percentChange"],
            "direction": entry["direction"],
        }
        for entry in entries
    ]

    return ConsumptionAnomaliesResponse.model_validate(
        {"anomalies": anomalies, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


@tool
async def calculate_reorder_quantity(product_id: int, warehouse_id: int) -> dict:
    """Get the backend-calculated recommended reorder quantity for one product at one warehouse.

    Reuses GET /stock-insights/restock-recommendations (the same real
    endpoint get_restock_recommendations() calls) and filters client-side
    to the requested pair - that endpoint doesn't take productId/
    warehouseId as query params. There is no separate reorder-quantity
    endpoint or named calculation method (no EOQ, no lead-time-demand) -
    the backend computes exactly one thing: how much would bring
    projected available stock back up to the existing reorderThreshold,
    and ONLY for pairs it has already flagged at-risk/out-of-stock.

    Args:
        product_id: The product's database ID.
        warehouse_id: The warehouse's database ID.

    Returns:
        A dict with `recommendedQuantity` and `status`. When the backend
        has a real recommendation for this exact pair, status is
        "reorder_recommended" and recommendedQuantity is that real value.
        When it doesn't (the pair is currently healthy - the backend
        never flagged it), status is "not_at_risk" and
        recommendedQuantity is 0 - a genuine "no reorder needed" answer,
        not missing data.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()
    entries = await client.get("/stock-insights/restock-recommendations")

    match = next(
        (entry for entry in entries if entry["productId"] == product_id and entry["warehouseId"] == warehouse_id),
        None,
    )

    if match is not None:
        result = {
            "productId": product_id,
            "warehouseId": warehouse_id,
            "recommendedQuantity": match["recommendedQuantity"],
            "status": "reorder_recommended",
        }
    else:
        result = {
            "productId": product_id,
            "warehouseId": warehouse_id,
            "recommendedQuantity": 0,
            "status": "not_at_risk",
        }

    return ReorderQuantityResult.model_validate(result).model_dump(mode="json")


@tool
async def compare_suppliers(product_id: int) -> dict:
    """Compare available suppliers for a product on cost, lead time, and reliability.

    Returns a backend-scored list plus a single recommendedSupplier. The
    recommended supplier is NOT necessarily the cheapest - it weighs lead
    time and reliability alongside cost. Always mention this trade-off when
    presenting the recommendation.

    Composes two real backend calls, never three: GET /supplier-intelligence/rank
    already returns every field GET /supplier-intelligence/compare does (rank
    is computed from compare's own data, not a separate calculation) plus
    the score/rank/insufficientData fields compare lacks, so /compare is
    never called. recommendedSupplier is derived client-side as the
    rank === 1 entry - exactly what GET /supplier-intelligence/best does
    internally (ranked.find(s => s.rank === 1) ?? null) - so /best is
    never called either. leadTimeDays isn't on either supplier-intelligence
    endpoint at all (it's a raw Supplier field), so one GET /suppliers call
    supplies it for every supplier in one shot.

    Args:
        product_id: The product's database ID.

    Returns:
        A dict with a `scores` list (per-supplier unitCost, leadTimeDays,
        reliabilityScore, overallScore, rank, insufficientData,
        insufficientDataReasons - insufficient-data suppliers are KEPT in
        the list, never dropped, matching the backend's own behavior),
        `recommendedSupplier` (None when no supplier reached rank 1), and
        `recommendationStatus` ("supplier_recommended" or
        "no_recommendation" - a real, deliberate answer, not missing data).
        unitCost/leadTimeDays/reliabilityScore/overallScore are None
        exactly when the real backend has no value for that supplier -
        never defaulted to 0.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if a backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()

    suppliers = await client.get("/suppliers")
    lead_time_by_supplier_id = {supplier["id"]: supplier["leadTimeDays"] for supplier in suppliers}

    ranked = await client.get("/supplier-intelligence/rank", params={"productId": product_id})

    scores = [
        {
            "supplierId": entry["supplierId"],
            "supplierName": entry["supplierName"],
            "unitCost": entry["averagePrice"],
            "leadTimeDays": lead_time_by_supplier_id.get(entry["supplierId"]),
            "reliabilityScore": entry["onTimeDeliveryRate"],
            "overallScore": entry["score"],
            "rank": entry["rank"],
            "insufficientData": entry["insufficientData"],
            "insufficientDataReasons": entry["insufficientDataReasons"],
        }
        for entry in ranked
    ]

    recommended = next((score for score in scores if score["rank"] == 1), None)

    result = {
        "productId": product_id,
        "scores": scores,
        "recommendedSupplier": recommended,
        "recommendationStatus": "supplier_recommended" if recommended is not None else "no_recommendation",
    }

    return SupplierComparisonResponse.model_validate(result).model_dump(mode="json")


def _sum_transaction_value(items: list[dict]) -> float:
    """Sum quantity * price across items that actually have a price.

    price arrives from the backend as a Prisma Decimal, which decimal.js
    serializes over HTTP as a JSON STRING (e.g. "500.5"), not a JSON number
    - so it must be explicitly converted, never assumed numeric already. An
    item with no price (InventoryTransactionItem.price is optional in the
    schema) is EXCLUDED from the sum rather than treated as free (0) -
    silently treating "unknown price" as "free" would misrepresent the
    total. This mirrors the same convention the backend's own
    calculateTransactionCost() already uses, recomputed here in the tool's
    own code per the task rather than calling that per-transaction endpoint
    (which would mean one extra HTTP call per order).
    """
    total = 0.0
    for item in items:
        price = item.get("price")
        if price is None:
            continue
        total += item["quantity"] * float(price)
    return total


@tool
async def get_open_purchase_orders() -> dict:
    """Get all currently open (PENDING, not yet received) purchase orders across all warehouses.

    A "purchase order" here is a PENDING INCOMING inventory transaction -
    the backend has no separate PurchaseOrder entity. Only PENDING is
    "open"; COMPLETED/CANCELLED transactions are not returned.

    Returns:
        A dict with an `orders` list. Each item carries `status` (always
        PENDING here - a direct pass-through of the backend's own 3-value
        enum, no remapping), `expectedDate`, `lineItemCount` (the real
        number of line items on the order), and `totalValue` (quantity *
        price summed across items that have a recorded price - items
        without one are excluded, not treated as free; see
        _sum_transaction_value). No supplierName/warehouseName - the
        backend doesn't join those on this endpoint.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()
    transactions = await client.get(
        "/inventory-transactions",
        params={"type": "INCOMING", "status": "PENDING"},
    )

    orders = [
        {
            "purchaseOrderId": transaction["id"],
            "supplierId": transaction["supplierId"],
            "warehouseId": transaction["destinationWarehouseId"],
            "status": transaction["status"],
            "expectedDate": transaction["expectedDate"],
            "lineItemCount": len(transaction["items"]),
            "totalValue": _sum_transaction_value(transaction["items"]),
        }
        for transaction in transactions
    ]

    return OpenPurchaseOrdersResponse.model_validate(
        {"orders": orders, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")


def _qualifying_warehouses_by_recency(movements: list[dict], exclude_warehouse_id: int) -> list[int]:
    """Distinct OTHER warehouses with an OUTGOING movement, most-recent-sale first.

    exclude_warehouse_id is always the dead-stock entry's OWN warehouse - an
    OUTGOING movement there is that warehouse's own (old) sale history, not
    evidence that some OTHER warehouse can receive a transfer, so it is
    filtered out regardless of its date.

    The resulting order is what recommend_dead_stock_transfer()'s remainder
    distribution (see _compute_recommended_transfers) uses as its tie-break:
    when a transfer amount doesn't split evenly across qualifying
    warehouses, the extra unit(s) go to whichever warehouse(s) sold this
    product most recently - recent demand is the best available signal for
    where the stock is likely to be useful soonest.
    """
    latest_by_warehouse: dict[int, str] = {}
    for movement in movements:
        warehouse_id = movement["warehouseId"]
        if warehouse_id == exclude_warehouse_id:
            continue
        created_at = movement["createdAt"]
        if warehouse_id not in latest_by_warehouse or created_at > latest_by_warehouse[warehouse_id]:
            latest_by_warehouse[warehouse_id] = created_at
    return sorted(latest_by_warehouse, key=lambda wid: latest_by_warehouse[wid], reverse=True)


def _compute_recommended_transfers(on_hand: int, qualifying_warehouse_ids_by_recency: list[int]) -> list[dict]:
    """Pure calculation: how much dead stock to transfer, and to which warehouses.

    transfer_amount = floor(on_hand / 2) - half the dead stock, rounded
    down, leaving the remainder in the original warehouse. Split evenly by
    COUNT of qualifying warehouses (not weighted by their sales volume - a
    deliberate simplicity choice, not an oversight). When it doesn't divide
    evenly, the leftover unit(s) go to the warehouse(s) earliest in
    qualifying_warehouse_ids_by_recency - i.e. whichever sold this product
    most recently (see _qualifying_warehouses_by_recency for why).

    Returns a list of {"destinationWarehouseId": int, "quantity": int}, one
    entry per qualifying warehouse that ends up with a nonzero quantity.
    Empty when there are no qualifying warehouses, or when on_hand is too
    small (0 or 1) to produce any nonzero transfer at all.
    """
    if not qualifying_warehouse_ids_by_recency:
        return []

    transfer_amount = on_hand // 2
    if transfer_amount <= 0:
        return []

    count = len(qualifying_warehouse_ids_by_recency)
    base_quantity, remainder = divmod(transfer_amount, count)

    transfers = []
    for index, warehouse_id in enumerate(qualifying_warehouse_ids_by_recency):
        quantity = base_quantity + (1 if index < remainder else 0)
        if quantity > 0:
            transfers.append({"destinationWarehouseId": warehouse_id, "quantity": quantity})
    return transfers


def _build_dead_stock_transfer_reason(
    days_since_last_outgoing: Optional[int],
    qualifying_count: int,
    on_hand: int,
    has_transfers: bool,
) -> str:
    """Plain-language explanation matching one of the three outcomes _compute_recommended_transfers can produce.

    days_since_last_outgoing is None when the real backend's
    daysSinceLastOutgoingMovement is null - a product that has NEVER had
    an OUTGOING movement at this warehouse (not just "not recently"; see
    DeadStockEntry in backend/src/stock-insights/stock-insights.service.ts).
    Found live against the real backend's actual seed data, which the
    original hand-built mock fixtures never modeled (they only ever used a
    concrete day count) - phrased separately here rather than rendering
    "No sales in None days".
    """
    staleness = (
        "has never had a recorded sale at this warehouse"
        if days_since_last_outgoing is None
        else f"has had no sales in {days_since_last_outgoing} days at this warehouse"
    )
    if qualifying_count == 0:
        return (
            f"This product {staleness}, and no other warehouse has sold it in the last "
            f"{_DEAD_STOCK_TRANSFER_LOOKBACK_DAYS} days - no transfer destination available."
        )
    if not has_transfers:
        return (
            f"This product {staleness}; {qualifying_count} other warehouse(s) sold it recently, "
            f"but on-hand quantity ({on_hand}) is too low to recommend a meaningful transfer."
        )
    plural = "s" if qualifying_count != 1 else ""
    return (
        f"This product {staleness}; sold recently in {qualifying_count} other warehouse{plural} - "
        "recommending a transfer to rebalance stock."
    )


@tool
async def recommend_dead_stock_transfer() -> dict:
    """Recommend rebalancing dead stock to warehouses where the same product is still selling.

    READ-ONLY / recommendation-only. This NEVER executes a transfer - it
    only composes two real backend endpoints (dead-stock entries from
    GET /stock-insights/dead-stock, and each dead product's recent
    OUTGOING movement history at other warehouses from
    GET /stock-movements/ledger) into a proposal for a human to review and
    confirm manually via the existing warehouse-transfer feature. Always
    describe its output as a proposal, never as an action already taken.

    For each dead-stock entry, checks which OTHER warehouses sold that same
    product in the last 60 days. If at least one did, proposes moving half
    of the dead-stock warehouse's on-hand quantity (rounded down - the
    remainder stays put) to those warehouse(s), split evenly by COUNT (not
    weighted by sales volume). If the split doesn't divide evenly, the
    extra unit(s) go to whichever qualifying warehouse(s) sold the product
    most recently. If no other warehouse has sold it recently, no transfer
    is proposed for that entry - it is still reported, as dead stock with
    no available destination.

    Returns:
        A dict with a `recommendations` list. Each item has productId,
        sourceWarehouseId, onHand, a recommendedTransfers list of
        {destinationWarehouseId, quantity} (empty when there's no
        qualifying destination warehouse), and a short `reason` string
        explaining the basis for - or absence of - a recommendation.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if a backend call
        itself fails. Deliberately NOT caught/swallowed here - Strands
        turns a raised exception into a proper tool-error result, and per
        this agent's own rules (see prompts.py, rule 5), the agent must
        then either genuinely retry the call or honestly tell the user the
        lookup failed - never fabricate a result.
    """
    client = get_backend_client()
    dead_stock_entries = await client.get("/stock-insights/dead-stock")
    date_from = datetime.now() - timedelta(days=_DEAD_STOCK_TRANSFER_LOOKBACK_DAYS)

    recommendations = []
    for entry in dead_stock_entries:
        movements = await client.get(
            "/stock-movements/ledger",
            params={
                "productId": entry["productId"],
                "type": "OUTGOING",
                "dateFrom": date_from.isoformat(),
            },
        )
        qualifying_warehouses = _qualifying_warehouses_by_recency(movements, entry["warehouseId"])
        transfers = _compute_recommended_transfers(entry["onHand"], qualifying_warehouses)
        reason = _build_dead_stock_transfer_reason(
            days_since_last_outgoing=entry["daysSinceLastOutgoingMovement"],
            qualifying_count=len(qualifying_warehouses),
            on_hand=entry["onHand"],
            has_transfers=bool(transfers),
        )
        recommendations.append(
            {
                "productId": entry["productId"],
                "sourceWarehouseId": entry["warehouseId"],
                "onHand": entry["onHand"],
                "recommendedTransfers": transfers,
                "reason": reason,
            }
        )

    return RecommendDeadStockTransferResponse.model_validate(
        {"recommendations": recommendations, "asOf": datetime.now().isoformat()}
    ).model_dump(mode="json")
