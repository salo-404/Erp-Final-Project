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
from decimal import Decimal
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared enums
# ---------------------------------------------------------------------------


class RestockReason(str, Enum):
    """Why the backend flagged a product for restocking."""

    TRANSFER_AVAILABLE = "transfer_available"
    PURCHASE_REQUIRED = "purchase_required"


class StockoutRiskLevel(str, Enum):
    OUT_OF_STOCK = "OUT_OF_STOCK"
    AT_RISK = "AT_RISK"
    OK = "OK"


class ExpiryRiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class ConsumptionAnomalyDirection(str, Enum):
    INCREASE = "INCREASE"
    DECREASE = "DECREASE"


# ---------------------------------------------------------------------------
# get_available_stock
# ---------------------------------------------------------------------------


class AvailableStockItem(BaseModel):
    productId: int
    warehouseId: int
    onHand: int = Field(..., description="Units physically on hand.")
    reserved: int = Field(0, description="Units held by ACTIVE reservations.")
    available: int = Field(..., description="onHand - reserved. Backend-calculated.")


class AvailableStockResponse(BaseModel):
    items: list[AvailableStockItem]


# ---------------------------------------------------------------------------
# get_low_stock_products
# ---------------------------------------------------------------------------


class LowStockItem(BaseModel):
    inventoryId: int
    productId: int
    productName: str
    warehouseId: int
    onHand: int
    reserved: int
    available: int
    reorderThreshold: int


class LowStockResponse(BaseModel):
    items: list[LowStockItem]


# ---------------------------------------------------------------------------
# get_stockout_risk
# ---------------------------------------------------------------------------


class StockoutRiskItem(BaseModel):
    productId: int
    warehouseId: int
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


# ---------------------------------------------------------------------------
# get_restock_recommendations
# ---------------------------------------------------------------------------


class RestockRecommendation(BaseModel):
    productId: int
    warehouseId: int
    available: int
    pendingIncomingQuantity: int
    projectedAvailable: int
    reorderThreshold: int
    riskLevel: StockoutRiskLevel
    projectedRiskLevel: StockoutRiskLevel
    recommendedQuantity: int
    avgDailyConsumption: float
    daysOfSupply: Optional[float] = None
    reason: RestockReason
    explanation: str


class RestockRecommendationsResponse(BaseModel):
    recommendations: list[RestockRecommendation]


# ---------------------------------------------------------------------------
# get_transfer_recommendations
# ---------------------------------------------------------------------------


class TransferRecommendation(BaseModel):
    productId: int
    fromWarehouseId: int
    toWarehouseId: int
    transferQuantity: int
    fromWarehouseAvailableAfterTransfer: int
    toWarehouseProjectedAvailableAfterTransfer: int
    sourcePendingIncomingQuantity: int
    sourceIsDeadStock: bool
    destinationRiskLevel: StockoutRiskLevel
    destinationAvgDailyConsumption: float
    destinationDaysOfSupply: Optional[float] = None


class TransferRecommendationsResponse(BaseModel):
    recommendations: list[TransferRecommendation]


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
    warehouseId: int
    onHand: int
    lastMovementAt: Optional[datetime] = None
    daysSinceLastMovement: Optional[int] = None
    lastOutgoingMovementAt: Optional[datetime] = None
    daysSinceLastOutgoingMovement: Optional[int] = None


class DeadStockResponse(BaseModel):
    items: list[DeadStockItem]


# ---------------------------------------------------------------------------
# get_consumption_anomalies
# ---------------------------------------------------------------------------


class ConsumptionAnomaly(BaseModel):
    productId: int
    recentQuantity: int
    baselineQuantity: int
    percentChange: Optional[float] = None
    direction: ConsumptionAnomalyDirection


class ConsumptionAnomaliesResponse(BaseModel):
    anomalies: list[ConsumptionAnomaly]


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


class SupplierRankingComponentScores(BaseModel):
    price: Optional[float] = None
    onTimeDelivery: Optional[float] = None
    cancellationPerformance: float
    productSupplyHistory: Optional[float] = None


class RankedSupplier(BaseModel):
    supplierId: int
    supplierName: str
    productId: int
    totalTransactions: int
    completedTransactions: int
    cancelledTransactions: int
    cancellationRate: float
    averagePrice: Optional[float] = None
    pricedItemCount: int
    onTimeDeliveryRate: Optional[float] = None
    evaluatedForOnTimeCount: int
    purchaseFrequency: float
    firstPurchaseDate: Optional[datetime] = None
    lastPurchaseDate: Optional[datetime] = None
    rank: Optional[int] = None
    score: Optional[float] = None
    insufficientData: bool
    insufficientDataReasons: list[str]
    componentScores: SupplierRankingComponentScores


class SupplierComparisonResponse(BaseModel):
    productId: int
    suppliers: list[RankedSupplier]


# ---------------------------------------------------------------------------
# get_open_purchase_orders
# ---------------------------------------------------------------------------


class OpenIncomingTransactionItem(BaseModel):
    itemId: int
    productId: int
    quantity: int
    price: Optional[Decimal] = None


class OpenIncomingTransaction(BaseModel):
    transactionId: int
    type: Literal["INCOMING"]
    status: Literal["PENDING"]
    supplierId: Optional[int] = None
    destinationWarehouseId: Optional[int] = None
    expectedDate: Optional[datetime] = None
    actualDate: Optional[datetime] = None
    deliveryCountry: Optional[str] = None
    deliveryRegion: Optional[str] = None
    deliveryAddress: Optional[str] = None
    documentUrl: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime
    items: list[OpenIncomingTransactionItem]


class OpenPurchaseOrdersResponse(BaseModel):
    transactions: list[OpenIncomingTransaction]


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
