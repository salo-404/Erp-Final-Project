"""Pydantic contracts for the real NestJS document-review workflow."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field

TransactionType = Literal["INCOMING", "OUTGOING"]
ReviewStatus = Literal["PENDING_REVIEW", "APPROVED", "REJECTED"]


class ExtractedReviewItem(BaseModel):
    product: str
    quantity: int
    price: Optional[Decimal] = None


class PendingDocumentReview(BaseModel):
    id: int
    documentUrl: str
    documentKey: Optional[str] = None
    transactionType: TransactionType
    extractedPartyName: Optional[str] = None
    extractedSupplierName: Optional[str] = None
    extractedDate: Optional[datetime] = None
    extractedWarehouseName: Optional[str] = None
    extractedDeliveryCountry: Optional[str] = None
    extractedDeliveryRegion: Optional[str] = None
    extractedDeliveryAddress: Optional[str] = None
    extractedItems: list[ExtractedReviewItem]
    status: ReviewStatus
    rejectionReason: Optional[str] = None
    reviewedById: Optional[int] = None
    reviewedAt: Optional[datetime] = None
    transactionId: Optional[int] = None
    createdAt: datetime
    updatedAt: datetime


class PendingDocumentReviewsResponse(BaseModel):
    reviews: list[PendingDocumentReview]


class TransactionItem(BaseModel):
    id: int
    transactionId: int
    productId: int
    quantity: int
    price: Optional[Decimal] = None


class ResultingTransaction(BaseModel):
    id: int
    type: Literal["INCOMING", "OUTGOING", "TRANSFER"]
    status: Literal["PENDING", "COMPLETED", "CANCELLED"]
    sourceWarehouseId: Optional[int] = None
    destinationWarehouseId: Optional[int] = None
    supplierId: Optional[int] = None
    deliveryCountry: Optional[str] = None
    deliveryRegion: Optional[str] = None
    deliveryAddress: Optional[str] = None
    expectedDate: Optional[datetime] = None
    actualDate: Optional[datetime] = None
    partyName: Optional[str] = None
    documentUrl: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime
    items: list[TransactionItem]


class ReviewerSummary(BaseModel):
    id: int
    name: str
    email: str
    role: Literal["ADMIN", "EMPLOYEE"]


class DocumentReviewDetail(PendingDocumentReview):
    transaction: Optional[ResultingTransaction] = None
    reviewedBy: Optional[ReviewerSummary] = None


class ProductSuggestion(BaseModel):
    productId: int
    name: str
    score: float = Field(..., ge=0, le=1)


class ProductResolutionResponse(BaseModel):
    query: str
    suggestions: list[ProductSuggestion]


class SupplierSuggestion(BaseModel):
    supplierId: int
    name: str
    score: float = Field(..., ge=0, le=1)


class SupplierResolutionResponse(BaseModel):
    query: str
    suggestions: list[SupplierSuggestion]


class ConfirmedDocumentItem(BaseModel):
    productId: int = Field(..., gt=0)
    quantity: int = Field(..., gt=0)
    price: Optional[float] = Field(None, ge=0)


class ApproveDocumentReviewRequest(BaseModel):
    items: list[ConfirmedDocumentItem] = Field(..., min_length=1)
    expectedDate: Optional[datetime] = None
    supplierId: Optional[int] = Field(None, gt=0)
    destinationWarehouseId: Optional[int] = Field(None, gt=0)
    sourceWarehouseId: Optional[int] = Field(None, gt=0)
    partyName: Optional[str] = None
    deliveryCountry: Optional[str] = None
    deliveryRegion: Optional[str] = None
    deliveryAddress: Optional[str] = None


class RejectDocumentReviewRequest(BaseModel):
    rejectionReason: str = Field(..., min_length=1)
