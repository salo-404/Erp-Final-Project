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
    """Why the backend flagged a product for restocking."""

    BELOW_THRESHOLD = "BELOW_THRESHOLD"
    STOCKOUT_PREDICTED = "STOCKOUT_PREDICTED"
    SEASONAL_DEMAND = "SEASONAL_DEMAND"
    SUPPLIER_LEAD_TIME_RISK = "SUPPLIER_LEAD_TIME_RISK"


class StockoutRiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class ExpiryRiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class DeadStockReason(str, Enum):
    NO_MOVEMENT = "NO_MOVEMENT"
    OVERSTOCKED = "OVERSTOCKED"
    DISCONTINUED_CANDIDATE = "DISCONTINUED_CANDIDATE"


class AnomalyType(str, Enum):
    SPIKE = "SPIKE"
    DROP = "DROP"
    IRREGULAR_PATTERN = "IRREGULAR_PATTERN"


class PurchaseOrderStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    IN_TRANSIT = "IN_TRANSIT"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"


# ---------------------------------------------------------------------------
# get_available_stock
# ---------------------------------------------------------------------------


class AvailableStockItem(BaseModel):
    productId: int
    productName: str
    warehouseId: int
    warehouseName: str
    onHand: int = Field(..., description="Units physically on hand.")
    reserved: int = Field(0, description="Units already reserved against open orders.")
    available: int = Field(..., description="onHand - reserved. Backend-calculated.")


class AvailableStockResponse(BaseModel):
    items: list[AvailableStockItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_low_stock_products
# ---------------------------------------------------------------------------


class LowStockItem(BaseModel):
    productId: int
    productName: str
    warehouseId: int
    warehouseName: str
    onHand: int
    reorderThreshold: int
    deficit: int = Field(..., description="reorderThreshold - onHand. Backend-calculated.")


class LowStockResponse(BaseModel):
    items: list[LowStockItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_stockout_risk
# ---------------------------------------------------------------------------


class StockoutRiskItem(BaseModel):
    productId: int
    productName: str
    warehouseId: int
    warehouseName: str
    riskLevel: StockoutRiskLevel
    riskScore: float = Field(..., ge=0, le=1, description="Backend-calculated probability, 0-1.")
    projectedStockoutDate: Optional[datetime] = None
    averageDailyConsumption: float


class StockoutRiskResponse(BaseModel):
    items: list[StockoutRiskItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_restock_recommendations
# ---------------------------------------------------------------------------


class RestockCandidate(BaseModel):
    """A candidate supplier/source for the recommended restock."""

    supplierId: int
    supplierName: str
    unitCost: float
    leadTimeDays: int


class RestockRecommendation(BaseModel):
    productId: int
    productName: str
    warehouseId: int
    warehouseName: str
    needsReorder: bool
    reason: RestockReason
    quantity: int = Field(..., description="Backend-calculated recommended reorder quantity.")
    candidate: RestockCandidate = Field(
        ..., description="Backend-recommended supplier candidate for this reorder."
    )


class RestockRecommendationsResponse(BaseModel):
    recommendations: list[RestockRecommendation]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_transfer_recommendations
# ---------------------------------------------------------------------------


class TransferRecommendation(BaseModel):
    productId: int
    productName: str
    sourceWarehouseId: int
    sourceWarehouseName: str
    destinationWarehouseId: int
    destinationWarehouseName: str
    quantity: int
    reason: str = Field(..., description="e.g. 'Destination below threshold, source has surplus'.")


class TransferRecommendationsResponse(BaseModel):
    recommendations: list[TransferRecommendation]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_expiry_risk
# ---------------------------------------------------------------------------


class ExpiryRiskItem(BaseModel):
    productId: int
    productName: str
    warehouseId: int
    warehouseName: str
    batchId: Optional[str] = None
    quantity: int
    expiryDate: datetime
    daysUntilExpiry: int
    riskLevel: ExpiryRiskLevel


class ExpiryRiskResponse(BaseModel):
    items: list[ExpiryRiskItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# analyze_dead_stock
# ---------------------------------------------------------------------------


class DeadStockItem(BaseModel):
    productId: int
    productName: str
    warehouseId: int
    warehouseName: str
    onHand: int
    daysSinceLastMovement: int
    reason: DeadStockReason
    tiedUpCapital: float = Field(..., description="onHand * unitCost, backend-calculated.")


class DeadStockResponse(BaseModel):
    items: list[DeadStockItem]
    asOf: datetime


# ---------------------------------------------------------------------------
# get_consumption_anomalies
# ---------------------------------------------------------------------------


class ConsumptionAnomaly(BaseModel):
    productId: int
    productName: str
    warehouseId: int
    warehouseName: str
    anomalyType: AnomalyType
    observedQuantity: float
    expectedQuantity: float = Field(..., description="Backend-calculated baseline.")
    deviationPercent: float
    detectedAt: datetime


class ConsumptionAnomaliesResponse(BaseModel):
    anomalies: list[ConsumptionAnomaly]
    asOf: datetime


# ---------------------------------------------------------------------------
# calculate_reorder_quantity
# ---------------------------------------------------------------------------


class ReorderQuantityResult(BaseModel):
    productId: int
    warehouseId: int
    recommendedQuantity: int = Field(..., description="Backend-calculated, e.g. EOQ-based.")
    method: str = Field(..., description="e.g. 'economic_order_quantity', 'lead_time_demand'.")


# ---------------------------------------------------------------------------
# compare_suppliers
# ---------------------------------------------------------------------------


class SupplierScore(BaseModel):
    supplierId: int
    supplierName: str
    unitCost: float
    leadTimeDays: int
    reliabilityScore: float = Field(..., ge=0, le=1, description="Backend-calculated on-time-delivery rate.")
    overallScore: float = Field(
        ..., ge=0, le=1, description="Backend-calculated composite score weighing cost, lead time, reliability."
    )


class SupplierComparisonResponse(BaseModel):
    productId: int
    scores: list[SupplierScore]
    recommendedSupplier: SupplierScore = Field(
        ..., description="Backend-selected best overall candidate, not just cheapest."
    )


# ---------------------------------------------------------------------------
# get_open_purchase_orders
# ---------------------------------------------------------------------------


class OpenPurchaseOrder(BaseModel):
    purchaseOrderId: int
    supplierId: int
    supplierName: str
    warehouseId: int
    warehouseName: str
    status: PurchaseOrderStatus
    expectedDate: Optional[datetime] = None
    lineItemCount: int
    totalValue: float


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
