"""Pydantic response models for the Insights agent's tools.

These models double as the draft API contract between the AI layer and the
backend team (see Backend_vs_AI_Work_Split). Field names are intentionally
kept in sync with the Prisma schema (WarehouseInventory.onHand,
WarehouseInventory.reorderThreshold, Product, Warehouse, Supplier) so that
swapping the mocked tool bodies for real backend calls later doesn't require
renaming fields the frontend already consumes.

Every numeric/statistical value here (risk scores, quantities, dates) is
expected to be CALCULATED BY THE BACKEND. The AI layer only interprets and
narrates these values - see agents/insights_agent/prompts.py.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared enums
# ---------------------------------------------------------------------------


class RestockReason(str, Enum):
    """Matches the real backend's RestockReason exactly (see
    backend/src/stock-insights/stock-insights.service.ts) - direct
    pass-through, no remapping. Previously a fabricated 4-value enum
    (BELOW_THRESHOLD/STOCKOUT_PREDICTED/SEASONAL_DEMAND/
    SUPPLIER_LEAD_TIME_RISK) with no real backend equivalent at all;
    replaced with the real 2-value enum the backend actually computes.
    Values are lowercase to match the real string literals exactly.
    """

    TRANSFER_AVAILABLE = "transfer_available"
    PURCHASE_REQUIRED = "purchase_required"


class StockoutRiskLevel(str, Enum):
    """Matches the real backend's StockoutRiskLevel exactly (see
    backend/src/stock-insights/stock-insights.service.ts) - direct
    pass-through, no remapping. Previously a 4-value LOW/MEDIUM/HIGH/
    CRITICAL enum requiring a judgment-call mapping (AT_RISK split on
    daysOfSupply); removed in favor of passing the real value straight
    through, since that mapping added a fabricated distinction the
    backend itself doesn't make.
    """

    OK = "OK"
    AT_RISK = "AT_RISK"
    OUT_OF_STOCK = "OUT_OF_STOCK"


class FulfillmentWarehouseStatus(str, Enum):
    NO_ELIGIBLE_WAREHOUSE = "NO_ELIGIBLE_WAREHOUSE"
    ELIGIBLE_WAREHOUSES_FOUND = "ELIGIBLE_WAREHOUSES_FOUND"
    RECOMMENDED = "RECOMMENDED"


class ConsumptionAnomalyDirection(str, Enum):
    """Matches the real backend's ConsumptionAnomalyDirection exactly (see
    backend/src/stock-insights/stock-insights.service.ts) - direct
    pass-through, no remapping. Previously a fabricated 3-value
    SPIKE/DROP/IRREGULAR_PATTERN enum (AnomalyType) with no real backend
    equivalent; replaced with the real 2-value enum the backend actually
    computes.
    """

    INCREASE = "INCREASE"
    DECREASE = "DECREASE"


class PurchaseOrderStatus(str, Enum):
    """Matches the real backend's InventoryTransactionStatus exactly (see
    generated/prisma/enums.ts) - direct pass-through, no remapping.
    Previously a fabricated 4-value PENDING/APPROVED/IN_TRANSIT/
    PARTIALLY_RECEIVED enum with no real backend equivalent; replaced with
    the real 3-value enum. get_open_purchase_orders() only ever returns
    PENDING rows (it filters status=PENDING), but the enum itself carries
    all 3 real values for schema accuracy.
    """

    PENDING = "PENDING"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


# ---------------------------------------------------------------------------
# get_available_stock
# ---------------------------------------------------------------------------


class AvailableStockItem(BaseModel):
    """productName/warehouseName come from GET /products and GET /warehouses
    respectively (see tools.py::get_available_stock) - both endpoints only
    return ACTIVE rows, so either name is None when product_id/warehouse_id
    refers to an inactive/deleted product or warehouse. onHand/reserved/
    available themselves are NOT filtered by isActive - real inventory data
    can still exist for an inactive product/warehouse - so a None name
    alongside real stock numbers is an expected, real combination, not a
    bug.
    """

    productId: int
    productName: Optional[str] = None
    warehouseId: int
    warehouseName: Optional[str] = None
    onHand: int = Field(..., description="Units physically on hand.")
    reserved: int = Field(0, description="Units already reserved against open orders.")
    available: int = Field(..., description="onHand - reserved. Backend-calculated.")


class AvailableStockResponse(BaseModel):
    items: list[AvailableStockItem]
    asOf: datetime
    # Non-null only when 2+ distinct product_ids were requested together -
    # not a backend field, computed tool-side (see tools.py::get_available_stock)
    # as a code-level safety net alongside the tool's own docstring guidance:
    # this response checks each product independently and never confirms
    # whole-order, single-warehouse fulfillment.
    note: Optional[str] = None


class FulfillmentWarehouseItem(BaseModel):
    productId: int
    onHand: int
    reserved: int
    available: int
    requestedQuantity: int


class FulfillmentWarehouseCandidate(BaseModel):
    warehouseId: int
    warehouseName: str
    location: Optional[str] = None
    items: list[FulfillmentWarehouseItem]
    distanceKm: Optional[float] = None


class FulfillmentWarehouseResponse(BaseModel):
    status: FulfillmentWarehouseStatus
    recommendedWarehouseId: Optional[int] = None
    recommendedWarehouseName: Optional[str] = None
    eligibleWarehouses: list[FulfillmentWarehouseCandidate]
    geographyConsidered: bool


# ---------------------------------------------------------------------------
# get_low_stock_products
# ---------------------------------------------------------------------------


class LowStockItem(BaseModel):
    """Field names/shape match the real backend's low-stock row (see
    GET /warehouse-inventory/low-stock/:warehouseId in
    warehouse-inventory.service.ts). productName comes from the real
    row's own `product` join (always present - the query always includes
    it, regardless of the product's isActive status). warehouseName does
    NOT come from this endpoint at all (no warehouse join here) - it's
    looked up from a separate GET /warehouses call, which only returns
    ACTIVE warehouses, so it's None on the rare case of an explicitly
    requested inactive warehouse_id (this endpoint's own low-stock query
    has no isActive filter, so that case can genuinely occur). `deficit`
    is NOT a backend field - it's real arithmetic computed in the tool's
    own code from real fields already on the row (max(reorderThreshold -
    available, 0)), not a fabricated number.
    """

    productId: int
    productName: str
    warehouseId: int
    warehouseName: Optional[str] = None
    onHand: int
    reorderThreshold: int
    reserved: int
    available: int
    deficit: int = Field(
        ..., description="max(reorderThreshold - available, 0) - computed in tools.py, not backend-provided."
    )


class LowStockResponse(BaseModel):
    items: list[LowStockItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_stockout_risk
#
# Wired to the real backend (see agents/insights_agent/tools.py). Reshaped
# against the ACTUAL StockoutRiskEntry returned by
# backend/src/stock-insights/stock-insights.service.ts's getStockoutRisk() -
# confirmed directly against that source, not assumed:
#   - productName/warehouseName do NOT exist on the real entry itself (the
#     backend never joins Product/Warehouse for this endpoint) - but ARE
#     included here, fetched separately via one shared GET /products +
#     GET /warehouses call (see tools.py::get_stockout_risk), same pattern
#     as get_available_stock. Originally dropped entirely under the same
#     no-fabrication principle as riskScore below; reversed on 2026-08-25
#     after confirming live that omitting them just moves the fabrication
#     risk downstream - the agent guessed a name instead, inventing a
#     nonexistent "Trieste Warehouse" and misnaming a real warehouse
#     across repeated runs. Fetching the real name is not fabrication;
#     leaving the agent to guess one is worse than the field being absent.
#   - No riskScore exists on the real entry either - dropped, not
#     computed/estimated by the AI layer.
#   - riskLevel is a direct pass-through of the real 3-value enum (OK/
#     AT_RISK/OUT_OF_STOCK - see StockoutRiskLevel above). An earlier
#     version of this tool remapped it onto a 4-value LOW/MEDIUM/HIGH/
#     CRITICAL enum with a daysOfSupply-based judgment call for splitting
#     AT_RISK - removed as unnecessary fabrication of a distinction the
#     backend doesn't make; simpler and more honest to pass the real value
#     straight through.
#   - Real field is predictedStockoutDate (this schema previously called it
#     projectedStockoutDate - a naming mismatch from before this tool was
#     wired against the verified real shape; renamed here to match).
#   - Real field names, including avgDailyConsumption, are preserved so
#     the adapter cannot silently drop or rename backend calculations.
# ---------------------------------------------------------------------------


class StockoutRiskItem(BaseModel):
    productId: int
    productName: Optional[str] = None
    warehouseId: int
    warehouseName: Optional[str] = None
    onHand: int
    activeReserved: int
    available: int
    reorderThreshold: int
    riskLevel: StockoutRiskLevel
    pendingIncomingQuantity: int
    projectedAvailable: int
    projectedRiskLevel: StockoutRiskLevel
    avgDailyConsumption: float
    daysOfSupply: Optional[float] = None
    predictedStockoutDate: Optional[datetime] = None


class StockoutRiskResponse(BaseModel):
    items: list[StockoutRiskItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_restock_recommendations
#
# Wired to the real backend (see agents/insights_agent/tools.py). Reshaped
# against the ACTUAL RestockRecommendation returned by
# backend/src/stock-insights/stock-insights.service.ts's
# getRestockRecommendations():
#   - productName/warehouseName ARE included (fetched separately, same
#     shared GET /products + GET /warehouses pattern as get_available_stock)
#     even though this endpoint itself doesn't join Product/Warehouse -
#     see StockoutRiskItem above for why this reverses an earlier
#     no-fabrication call that turned out to just push the fabrication
#     onto the agent instead.
#   - No needsReorder boolean - dropped. Every row this real endpoint
#     returns already needs a reorder by construction (rows a pending
#     incoming would fully resolve are excluded server-side, per
#     getRestockRecommendations()'s own doc comment) - a field that is
#     always True on every row that exists carries no information, so it
#     isn't worth a fabricated-looking always-true flag.
#   - No supplier `candidate` sub-object - this endpoint doesn't recommend
#     a supplier at all. RestockCandidate is removed; do NOT reintroduce
#     it by calling compare_suppliers() internally to fabricate one -
#     that's a different real endpoint answering a different question.
#   - recommendedQuantity is the real field name (this schema previously
#     called it `quantity`) - renamed here to match exactly.
#   - `explanation` is a REAL field the backend already generates
#     server-side (a human-readable sentence built from its own
#     calculated numbers) - kept and added here, since dropping genuinely
#     useful, non-fabricated backend output would be its own kind of
#     information loss, not caution.
# ---------------------------------------------------------------------------


class RestockRecommendation(BaseModel):
    productId: int
    productName: Optional[str] = None
    warehouseId: int
    warehouseName: Optional[str] = None
    available: int
    pendingIncomingQuantity: int
    projectedAvailable: int
    reorderThreshold: int
    riskLevel: StockoutRiskLevel
    projectedRiskLevel: StockoutRiskLevel
    recommendedQuantity: int = Field(..., description="Backend-calculated recommended reorder quantity.")
    avgDailyConsumption: float
    daysOfSupply: Optional[float] = None
    reason: RestockReason
    explanation: str = Field(..., description="Backend-generated human-readable explanation for this recommendation.")


class RestockRecommendationsResponse(BaseModel):
    recommendations: list[RestockRecommendation]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_transfer_recommendations
#
# Wired to the real backend (see agents/insights_agent/tools.py). Reshaped
# against the ACTUAL TransferRecommendation returned by
# backend/src/stock-insights/stock-insights.service.ts's
# getTransferRecommendations():
#   - productName/fromWarehouseName/toWarehouseName ARE included (fetched
#     separately, same shared GET /products + GET /warehouses pattern as
#     get_available_stock) - see StockoutRiskItem above for why this
#     reverses an earlier no-fabrication call.
#   - The real backend names fromWarehouseId/toWarehouseId/transferQuantity
#     and all backend-calculated post-transfer/source/destination fields are
#     preserved verbatim.
#   - No `reason` string exists on the real entry. Rather than drop it
#     (this field carries real value for narration) or let the MODEL
#     invent one (never allowed - see prompts.py rule 1), the tool
#     builds `reason` deterministically from real fields already on the
#     entry (destinationRiskLevel, destinationDaysOfSupply,
#     sourceIsDeadStock) - see _build_transfer_recommendation_reason().
# ---------------------------------------------------------------------------


class TransferRecommendation(BaseModel):
    productId: int
    productName: Optional[str] = None
    fromWarehouseId: int
    fromWarehouseName: Optional[str] = None
    toWarehouseId: int
    toWarehouseName: Optional[str] = None
    transferQuantity: int
    fromWarehouseAvailableAfterTransfer: int
    toWarehouseProjectedAvailableAfterTransfer: int
    sourcePendingIncomingQuantity: int
    sourceIsDeadStock: bool
    destinationRiskLevel: StockoutRiskLevel
    destinationAvgDailyConsumption: float
    destinationDaysOfSupply: Optional[float] = None
    reason: str = Field(
        ...,
        description=(
            "Deterministically generated by the AI layer from real backend fields "
            "(destinationRiskLevel, destinationDaysOfSupply, sourceIsDeadStock) - never model-generated."
        ),
    )


class TransferRecommendationsResponse(BaseModel):
    recommendations: list[TransferRecommendation]
    asOf: datetime


# ---------------------------------------------------------------------------
# analyze_dead_stock
#
# Wired to the real backend (see agents/insights_agent/tools.py). Reshaped
# against the ACTUAL DeadStockEntry returned by
# backend/src/stock-insights/stock-insights.service.ts's getDeadStock():
#   - No reason enum, no tiedUpCapital exist on the real entry - dropped
#     rather than fabricated, per explicit instruction.
#   - productName/warehouseName do NOT exist on the real entry either, but
#     ARE included here (fetched separately, same shared GET /products +
#     GET /warehouses pattern as get_available_stock) - see StockoutRiskItem
#     above for why this reverses an earlier no-fabrication call.
#   - The real entry carries TWO separate movement timestamps:
#     lastMovementAt (ANY movement type - informational only) and
#     lastOutgoingMovementAt (OUTGOING only - what actually determines
#     dead-stock status). Both are kept here rather than picking one,
#     since recommend_dead_stock_transfer() already treats
#     lastOutgoingMovementAt/daysSinceLastOutgoingMovement as the
#     authoritative pair - narration built on this tool's output can use
#     the same distinction rather than losing it. All four fields are
#     Optional: the real backend returns null for a product/warehouse pair
#     that has never had a movement of that type at all - not just "a
#     large day count" (the exact gap found and fixed in
#     recommend_dead_stock_transfer's reason-builder in the previous pass).
# ---------------------------------------------------------------------------


class DeadStockItem(BaseModel):
    productId: int
    productName: Optional[str] = None
    warehouseId: int
    warehouseName: Optional[str] = None
    onHand: int
    lastMovementAt: Optional[datetime] = None
    daysSinceLastMovement: Optional[int] = None
    lastOutgoingMovementAt: Optional[datetime] = None
    daysSinceLastOutgoingMovement: Optional[int] = None


class DeadStockResponse(BaseModel):
    items: list[DeadStockItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_consumption_anomalies
# ---------------------------------------------------------------------------


class ConsumptionAnomaly(BaseModel):
    """Field names/shape match the real backend's ConsumptionAnomaly exactly
    (see backend/src/stock-insights/stock-insights.service.ts). warehouseId
    was added back on 2026-08-20: the backend now evaluates consumption
    PER (productId, warehouseId) pair rather than summing a product's
    consumption across all its warehouses - a previous wiring pass
    correctly dropped this field because it didn't exist on the backend
    entry yet; this reverses that specific omission now that it does.
    productName/warehouseName are now included too (fetched separately,
    same shared GET /products + GET /warehouses pattern as
    get_available_stock) - see StockoutRiskItem above for why this
    reverses an earlier no-fabrication call (no product/warehouse join
    exists on this endpoint itself, but the names are fetched, not
    invented).
    """

    productId: int
    productName: Optional[str] = None
    warehouseId: int
    warehouseName: Optional[str] = None
    recentQuantity: int
    baselineQuantity: int
    percentChange: Optional[float] = Field(
        None, description="null when baselineQuantity is 0 (percentage change is undefined from a zero base)."
    )
    direction: ConsumptionAnomalyDirection


class ConsumptionAnomaliesResponse(BaseModel):
    anomalies: list[ConsumptionAnomaly]
    asOf: datetime


# ---------------------------------------------------------------------------
# calculate_reorder_quantity
# ---------------------------------------------------------------------------


class ReorderQuantityStatus(str, Enum):
    """No named calculation "method" exists in the real backend (see
    ReorderQuantityResult) - there's exactly one unnamed formula
    (max(reorderThreshold - projectedAvailable, 0)), and it's only ever
    computed for a (product, warehouse) pair the backend has ALREADY
    flagged at-risk/out-of-stock (getRestockRecommendations() filters to
    projectedRiskLevel != 'OK' before this number is even computed - see
    stock-insights.service.ts). This status distinguishes those two real
    outcomes instead of always implying a computed quantity exists.
    """

    REORDER_RECOMMENDED = "reorder_recommended"
    NOT_AT_RISK = "not_at_risk"


class ReorderQuantityResult(BaseModel):
    """recommendedQuantity/status are real backend data when status is
    reorder_recommended (the exact recommendedQuantity from a matching
    GET /stock-insights/restock-recommendations entry - see
    tools.py::calculate_reorder_quantity). When status is not_at_risk,
    recommendedQuantity is 0 by construction, not a real backend value -
    the backend never computed one for a healthy pair; 0 reflects "no
    reorder needed," not "an amount of zero was recommended." No `method`
    field - dropped entirely, see ReorderQuantityStatus.
    """

    productId: int
    warehouseId: int
    recommendedQuantity: int
    status: ReorderQuantityStatus


# ---------------------------------------------------------------------------
# compare_suppliers
# ---------------------------------------------------------------------------


class SupplierRecommendationStatus(str, Enum):
    """Distinguishes the two real outcomes GET /supplier-intelligence/best
    (reproduced client-side, see tools.py::compare_suppliers) can produce -
    a real top-ranked (rank === 1) supplier, or none (empty candidate list,
    or every candidate is insufficientData) - instead of always implying a
    recommendation exists. Same pattern as
    calculate_reorder_quantity's ReorderQuantityStatus.
    """

    SUPPLIER_RECOMMENDED = "supplier_recommended"
    NO_RECOMMENDATION = "no_recommendation"


class SupplierComponentScores(BaseModel):
    price: Optional[float]
    onTimeDelivery: Optional[float]
    cancellationPerformance: Optional[float]
    productSupplyHistory: Optional[float]


class SupplierScore(BaseModel):
    """Field names/shape match the real backend's RankedSupplier exactly
    (see backend/src/suppliers/supplier-intelligence.service.ts).
    unitCost/reliabilityScore/overallScore map to the real averagePrice/
    onTimeDeliveryRate/score fields respectively, and are None exactly
    when the real value is null (no priced items for this product from
    this supplier; no transactions with both expectedDate and actualDate;
    insufficientData) - never defaulted to 0 or fabricated. leadTimeDays
    comes from a separate GET /suppliers call (not part of this endpoint's
    own response) and is None when Supplier.leadTimeDays itself is null.
    overallScore is the real 0-100 composite score, NOT rescaled to 0-1 -
    the bound below matches the real range. insufficientData/
    insufficientDataReasons/rank are real backend fields, included so the
    agent can honestly explain why a supplier has no score yet rather than
    silently omitting them - the backend itself keeps these suppliers in
    the list (sorted after fully-ranked ones), not dropped.
    """

    supplierId: int
    supplierName: str
    productId: int
    totalTransactions: int
    completedTransactions: int
    cancelledTransactions: int
    cancellationRate: float
    unitCost: Optional[float] = Field(None, description="Real backend averagePrice; None when no priced items exist for this product from this supplier.")
    pricedItemCount: int
    leadTimeDays: Optional[int] = Field(None, description="From Supplier.leadTimeDays (separate GET /suppliers call); None when not set on the supplier record.")
    reliabilityScore: Optional[float] = Field(
        None, ge=0, le=1, description="Real backend onTimeDeliveryRate; None when no transactions have both expectedDate and actualDate."
    )
    evaluatedForOnTimeCount: int
    purchaseFrequency: float
    firstPurchaseDate: Optional[datetime] = None
    lastPurchaseDate: Optional[datetime] = None
    overallScore: Optional[float] = Field(
        None,
        ge=0,
        le=100,
        description="Real backend composite score (0-100 scale, not rescaled); None when insufficientData is true.",
    )
    rank: Optional[int] = Field(None, description="1-based rank among fully-evaluated suppliers; None when insufficientData is true (not ranked).")
    insufficientData: bool = Field(..., description="True when the backend could not compute a full score for this supplier.")
    insufficientDataReasons: list[str] = Field(
        default_factory=list, description="Human-readable reasons, real backend text - empty when insufficientData is false."
    )
    componentScores: SupplierComponentScores = Field(
        ...,
        description=(
            "Backend normalized components: price, onTimeDelivery, "
            "cancellationPerformance, and productSupplyHistory."
        ),
    )


class SupplierComparisonResponse(BaseModel):
    productId: int
    scores: list[SupplierScore]
    recommendedSupplier: Optional[SupplierScore] = Field(
        None, description="The rank===1 supplier, derived client-side exactly like the backend's own /best endpoint. None when recommendationStatus is no_recommendation."
    )
    recommendationStatus: SupplierRecommendationStatus


# ---------------------------------------------------------------------------
# get_open_purchase_orders
# ---------------------------------------------------------------------------


class OpenPurchaseOrder(BaseModel):
    """purchaseOrderId/warehouseId are renames of the real
    InventoryTransaction's id/destinationWarehouseId (see
    backend/src/inventory-transactions/inventory-transactions.service.ts).
    supplierName/warehouseName are dropped - GET /inventory-transactions
    doesn't join supplier/warehouse, only items. lineItemCount and
    totalValue and isOverdue are not backend fields - they're computed in
    the tool's own code from the transaction's real items[] and the shared
    UTC calendar-day rule, not fabricated.
    """

    purchaseOrderId: int
    supplierId: int
    warehouseId: int
    status: PurchaseOrderStatus
    expectedDate: Optional[datetime] = None
    isOverdue: bool = Field(
        ...,
        description="True only when still PENDING after its expected UTC calendar date.",
    )
    lineItemCount: int
    totalValue: Optional[float] = Field(
        None,
        description="quantity*price across priced items; null when no item has a recorded price.",
    )


class OpenPurchaseOrdersResponse(BaseModel):
    orders: list[OpenPurchaseOrder]
    asOf: datetime


# ---------------------------------------------------------------------------
# draft_purchase_order
# ---------------------------------------------------------------------------


class DraftPurchaseOrderLineItem(BaseModel):
    productId: int
    productName: str
    quantity: int
    unitCost: float


class DraftPurchaseOrderResponse(BaseModel):
    """A PROPOSAL only. Never executed/submitted by the agent."""

    supplierId: int
    supplierName: str
    warehouseId: int
    warehouseName: str
    lineItems: list[DraftPurchaseOrderLineItem]
    estimatedTotal: float
    estimatedLeadTimeDays: int
    isDraft: bool = Field(True, description="Always True - this proposal has not been submitted.")


# ---------------------------------------------------------------------------
# recommend_dead_stock_transfer
#
# Composes two existing, already-verified backend data sources -
# GET /stock-insights/dead-stock and GET /stock-movements/ledger - rather
# than a single dedicated backend endpoint. Field names on the dead-stock
# side (productId, warehouseId, onHand) intentionally match the REAL
# backend's DeadStockEntry shape confirmed in
# backend/src/stock-insights/stock-insights.service.ts, not
# analyze_dead_stock()'s AI-schema shape above (DeadStockItem) - the two
# diverge (e.g. daysSinceLastOutgoingMovement vs. daysSinceLastMovement,
# no productName/reason/tiedUpCapital here) because this tool is built
# directly against the confirmed real contract rather than the older,
# already-known-to-be-mismatched AI schema.
# ---------------------------------------------------------------------------


class RecommendedTransfer(BaseModel):
    destinationWarehouseId: int
    quantity: int = Field(..., gt=0, description="Units proposed to move to this destination warehouse.")


class DeadStockTransferRecommendation(BaseModel):
    productId: int
    sourceWarehouseId: int
    onHand: int
    recommendedTransfers: list[RecommendedTransfer] = Field(
        default_factory=list,
        description=(
            "Empty when no other warehouse has sold this product recently - "
            "dead stock with no available transfer destination."
        ),
    )
    reason: str = Field(..., description="Plain-language basis for (or absence of) this recommendation.")


class RecommendDeadStockTransferResponse(BaseModel):
    recommendations: list[DeadStockTransferRecommendation]


# ---------------------------------------------------------------------------
# resolve_product_name
# ---------------------------------------------------------------------------
#
# Deterministic product-name resolution, mirroring
# agents/document_agent/tools.py's _classify_fuzzy_match/match_products
# pattern (same rapidfuzz thresholds, same MATCHED/AMBIGUOUS/NOT_FOUND
# shape) but reimplemented locally rather than imported, so Insights stays
# fully standalone - it must not depend on document_agent internals, the
# same independence already enforced at the Supervisor level (Document is
# deliberately not wired into Supervisor's routing).
#
# Exists because query_database() (model-generated SQL, variable per-call
# result shape) was an unreliable way to answer "which product is the user
# referring to by name" - a small model has to both choose how to phrase
# the discovery question AND correctly interpret whatever columns/row
# count that specific SQL happened to produce. A fixed-schema tool removes
# that entire interpretation step: the agent gets a real MATCHED/AMBIGUOUS/
# NOT_FOUND verdict directly, the same way every other Insights tool
# already returns a fixed, unambiguous shape.


class ProductNameMatchStatus(str, Enum):
    MATCHED = "MATCHED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"


class ProductNameMatchCandidate(BaseModel):
    """One scored candidate, populated only when status is AMBIGUOUS."""

    productId: int
    productName: str
    score: float = Field(..., ge=0, le=100, description="rapidfuzz WRatio score, native 0-100 scale - not rescaled.")


class ResolveProductNameResponse(BaseModel):
    """See ProductMatch in tools/schemas/document_schema.py for the same
    confidence/candidates convention this mirrors. confidence is None only
    when status is NOT_FOUND. candidates (top 2-3 by score) is populated
    only when status is AMBIGUOUS.

    A MATCHED result is a confident SUGGESTION, not a certainty - text
    similarity can be fooled by a different-but-similar real product name
    (e.g. "Mouse Pad" can score high enough to match "Wireless Mouse"
    despite being a different, possibly nonexistent product). Insights
    must still sanity-check a surprising MATCHED result against context,
    same as Document does for its own fuzzy matches.
    """

    productNameRaw: str
    status: ProductNameMatchStatus
    productId: Optional[int] = None
    productName: Optional[str] = None
    confidence: Optional[float] = Field(None, ge=0, le=100, description="rapidfuzz WRatio score. None only when status is NOT_FOUND.")
    candidates: list[ProductNameMatchCandidate] = Field(
        default_factory=list, description="Top 2-3 scored candidates, populated only when status is AMBIGUOUS."
    )
    asOf: datetime
