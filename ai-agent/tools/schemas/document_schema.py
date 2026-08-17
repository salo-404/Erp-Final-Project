"""Pydantic response models for the Document agent's tools.

Field names track the backend's PendingDocumentReview model (extractedPartyName,
extractedSupplierName, extractedDate, extractedWarehouseName, extractedItems)
so these schemas can double as the draft API contract for the real
extraction backend. See Backend_vs_AI_Work_Split.

Every response tied to a specific document carries a `documentId` field
echoing the caller-supplied document_id, so a response can always be traced
back to which document it's actually about. This exists to close a real
bug: without it, a tool response looked equally plausible whether or not a
real document was ever behind it. See
tools/mocks/document_mock_data.py::DocumentNotFoundError for the other half
of that fix (every mock validates document_id against a known document
before returning anything).
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field

DocType = Literal["invoice", "order"]


# ---------------------------------------------------------------------------
# extract_document
# ---------------------------------------------------------------------------


class ExtractedLineItem(BaseModel):
    productNameRaw: str = Field(..., description="Product name/description as it appears on the document.")
    quantity: int
    unitPrice: Optional[float] = None


class ExtractDocumentResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    docType: DocType
    extractedPartyName: Optional[str] = Field(
        None, description="Customer name (order branch) or supplier-side contact name."
    )
    extractedSupplierName: Optional[str] = Field(None, description="Invoice branch only.")
    extractedDate: Optional[datetime] = None
    extractedWarehouseName: Optional[str] = None
    extractedDeliveryCountry: Optional[str] = None
    extractedDeliveryRegion: Optional[str] = None
    extractedItems: list[ExtractedLineItem]
    documentUrl: str


# ---------------------------------------------------------------------------
# match_products
# ---------------------------------------------------------------------------


class ProductMatchStatus(str, Enum):
    MATCHED = "MATCHED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"


class ProductMatch(BaseModel):
    productNameRaw: str
    status: ProductMatchStatus
    productId: Optional[int] = None
    productName: Optional[str] = None
    confidence: float = Field(..., ge=0, le=1, description="Backend-calculated match confidence.")
    candidates: list[int] = Field(
        default_factory=list, description="Candidate productIds when status is AMBIGUOUS."
    )


class MatchProductsResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    matches: list[ProductMatch]


# ---------------------------------------------------------------------------
# find_supplier (invoice branch only)
# ---------------------------------------------------------------------------


class SupplierMatchStatus(str, Enum):
    MATCHED = "MATCHED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"


class FindSupplierResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    extractedSupplierName: str
    status: SupplierMatchStatus
    supplierId: Optional[int] = None
    supplierName: Optional[str] = None
    confidence: float = Field(..., ge=0, le=1)
    candidates: list[int] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# match_invoice_to_po (invoice branch only)
# ---------------------------------------------------------------------------


class PoMatchStatus(str, Enum):
    MATCHED = "MATCHED"
    NO_MATCH = "NO_MATCH"
    MULTIPLE_CANDIDATES = "MULTIPLE_CANDIDATES"


class MatchInvoiceToPoResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    status: PoMatchStatus
    purchaseOrderId: Optional[int] = None
    confidence: float = Field(..., ge=0, le=1)
    candidatePurchaseOrderIds: list[int] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# find_customer (order branch only)
# ---------------------------------------------------------------------------


class CustomerMatchStatus(str, Enum):
    MATCHED = "MATCHED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"
    NEW_CUSTOMER = "NEW_CUSTOMER"


class FindCustomerResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    extractedPartyName: str
    status: CustomerMatchStatus
    customerId: Optional[int] = None
    customerName: Optional[str] = None
    confidence: float = Field(..., ge=0, le=1)


# ---------------------------------------------------------------------------
# choose_fulfillment_warehouse (order branch only)
# ---------------------------------------------------------------------------


class WarehouseCandidate(BaseModel):
    warehouseId: int
    warehouseName: str
    canFullyFulfill: bool
    distanceScore: float = Field(..., ge=0, le=1, description="Backend-calculated proximity score.")


class ChooseFulfillmentWarehouseResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    recommendedWarehouseId: int
    recommendedWarehouseName: str
    reason: str
    candidates: list[WarehouseCandidate]


# ---------------------------------------------------------------------------
# detect_duplicate_document
#
# Is THIS EXACT DOCUMENT a re-submission of something already processed
# before (same file uploaded twice, a resent email attachment, etc.)?
# Unrelated to whether its CONTENT matches what was expected - that's
# detect_discrepancy's job, below. Do not conflate the two: "has this
# document already been processed" (duplicate) vs. "does this document's
# data match what we expected" (discrepancy) are different questions.
# ---------------------------------------------------------------------------


class DuplicateMatch(BaseModel):
    documentReviewId: int
    similarityScore: float = Field(..., ge=0, le=1)
    matchedOn: list[str] = Field(
        ..., description="e.g. ['supplierName', 'totalAmount', 'date'] - which fields matched."
    )


class DetectDuplicateDocumentResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    isDuplicate: bool
    matches: list[DuplicateMatch]


# ---------------------------------------------------------------------------
# detect_discrepancy
#
# Does THIS DOCUMENT'S DATA (quantities, prices, line items) match the
# record it should match - a purchase order for an invoice, or the order
# itself for a fulfillment check? Unrelated to whether the document was
# already submitted before - that's detect_duplicate_document's job, above.
# ---------------------------------------------------------------------------


class DiscrepancyType(str, Enum):
    QUANTITY_MISMATCH = "QUANTITY_MISMATCH"
    PRICE_MISMATCH = "PRICE_MISMATCH"
    MISSING_LINE_ITEM = "MISSING_LINE_ITEM"
    UNEXPECTED_LINE_ITEM = "UNEXPECTED_LINE_ITEM"
    SUPPLIER_MISMATCH = "SUPPLIER_MISMATCH"


class Discrepancy(BaseModel):
    type: DiscrepancyType
    productId: Optional[int] = None
    productName: Optional[str] = None
    expectedValue: Optional[str] = None
    actualValue: Optional[str] = None
    severity: Literal["LOW", "MEDIUM", "HIGH"]


class DetectDiscrepancyResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    hasDiscrepancies: bool
    discrepancies: list[Discrepancy]
    comparedAgainst: Optional[str] = Field(
        None, description="e.g. 'purchaseOrderId=482' - what this document was compared against."
    )
