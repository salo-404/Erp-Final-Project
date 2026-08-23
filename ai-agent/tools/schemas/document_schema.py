"""Pydantic response models for the Document agent's tools.

Field names track the backend's PendingDocumentReview model (extractedPartyName,
extractedSupplierName, extractedDate, extractedWarehouseName, extractedItems)
so these schemas can double as the draft API contract for the real
extraction backend. See Backend_vs_AI_Work_Split.

Every response tied to a specific document carries a `documentId` field
echoing the caller-supplied document_id, so a response can always be traced
back to which document it's actually about. This exists to close a real
bug: without it, a tool response looked equally plausible whether or not a
real document was ever behind it. Every tool in agents/document_agent/tools.py
that looks up document_id now enforces the other half of that fix for
real - an unrecognized id 404s against the actual backend, never a
fabricated placeholder response.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

DocType = Literal["invoice", "order"]


# ---------------------------------------------------------------------------
# extract_document
# ---------------------------------------------------------------------------


class DocumentReviewStatus(str, Enum):
    """Matches the real backend's DocumentReviewStatus exactly (see
    schema.prisma) - direct pass-through, no remapping.
    """

    PENDING_REVIEW = "PENDING_REVIEW"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class BackendExtractedItem(BaseModel):
    product: str
    quantity: int = Field(..., gt=0)
    price: Optional[float] = Field(None, ge=0)


class DocumentReviewRecord(BaseModel):
    """SQL-visible PendingDocumentReview fields returned by the frozen backend.

    Detail responses additionally include `transaction` and `reviewedBy`;
    those nested Prisma objects are preserved without the AI inventing a
    second copy of their schema.
    """

    model_config = ConfigDict(extra="allow")

    id: int
    documentUrl: Optional[str] = None
    documentKey: Optional[str] = None
    transactionType: Optional[Literal["INCOMING", "OUTGOING", "TRANSFER"]] = None
    extractedPartyName: Optional[str] = None
    extractedSupplierName: Optional[str] = None
    extractedDate: Optional[datetime] = None
    extractedWarehouseName: Optional[str] = None
    extractedDeliveryCountry: Optional[str] = None
    extractedDeliveryRegion: Optional[str] = None
    extractedDeliveryAddress: Optional[str] = None
    extractedItems: list[BackendExtractedItem] = Field(default_factory=list)
    status: DocumentReviewStatus
    rejectionReason: Optional[str] = None
    reviewedById: Optional[int] = None
    reviewedAt: Optional[datetime] = None
    transactionId: Optional[int] = None
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None
    transaction: Optional[dict] = None
    reviewedBy: Optional[dict] = None


class PendingDocumentReviewsResponse(BaseModel):
    reviews: list[DocumentReviewRecord]


class ProductResolutionSuggestion(BaseModel):
    productId: int
    name: str
    score: float = Field(..., ge=0, le=1)


class SupplierResolutionSuggestion(BaseModel):
    supplierId: int
    name: str
    score: float = Field(..., ge=0, le=1)


class ResolutionStatus(str, Enum):
    RESOLVED = "RESOLVED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"


class ResolveDocumentProductResponse(BaseModel):
    documentId: str
    productNameRaw: str
    requestedQuantity: Optional[int] = Field(None, gt=0)
    status: ResolutionStatus
    productId: Optional[int] = None
    suggestions: list[ProductResolutionSuggestion]


class ResolveDocumentSupplierResponse(BaseModel):
    documentId: str
    supplierNameRaw: str
    status: ResolutionStatus
    supplierId: Optional[int] = None
    suggestions: list[SupplierResolutionSuggestion]


class DocumentReviewDecisionResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    status: DocumentReviewStatus


class ExtractedLineItem(BaseModel):
    """productNameRaw/unitPrice map to the real extractedItems entry's
    `product`/`price` (see PendingDocumentReview.extractedItems in
    schema.prisma - a Json blob shaped [{product, quantity, price?}]).
    unitPrice is None exactly when the real entry has no `price` -
    never defaulted to 0 or fabricated.
    """

    productNameRaw: str = Field(..., description="Product name/description as it appears on the document.")
    quantity: int
    unitPrice: Optional[float] = None


class ExtractDocumentResponse(BaseModel):
    """Field names track the real PendingDocumentReview model directly
    (see backend/prisma/schema.prisma). docType is derived from the real
    transactionType (INCOMING->invoice, OUTGOING->order) - the real
    upload-time validation rejects any other transactionType, so this
    mapping is exhaustive, not a guess. status/rejectionReason are real
    pass-through fields (rejectionReason is None unless status is
    REJECTED). extractedDeliveryAddress is a real field that had no
    AI-schema slot before this tool was wired - added here alongside
    the pre-existing extractedDeliveryCountry/extractedDeliveryRegion,
    which already matched real fields.
    """

    documentId: str = Field(..., description="The real PendingDocumentReview id, as a string - echoes the input document_id.")
    docType: DocType
    status: DocumentReviewStatus
    extractedPartyName: Optional[str] = Field(
        None, description="Customer name (order branch) or supplier-side contact name."
    )
    extractedSupplierName: Optional[str] = Field(None, description="Invoice branch only.")
    extractedDate: Optional[datetime] = None
    extractedWarehouseName: Optional[str] = None
    extractedDeliveryCountry: Optional[str] = None
    extractedDeliveryRegion: Optional[str] = None
    extractedDeliveryAddress: Optional[str] = None
    extractedItems: list[ExtractedLineItem]
    documentUrl: str
    rejectionReason: Optional[str] = Field(None, description="Set only when status is REJECTED.")


# ---------------------------------------------------------------------------
# match_products
# ---------------------------------------------------------------------------


class ProductMatchStatus(str, Enum):
    MATCHED = "MATCHED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"


class ProductMatchCandidate(BaseModel):
    """One scored candidate, used only in ProductMatch.candidates (AMBIGUOUS only)."""

    productId: int
    productName: str
    score: float = Field(..., ge=0, le=100, description="rapidfuzz WRatio score, native 0-100 scale - not rescaled.")


class ProductMatch(BaseModel):
    """confidence/candidates carry rapidfuzz's real WRatio score (see
    agents/document_agent/tools.py::_classify_fuzzy_match) - the native
    0-100 scale, not rescaled to 0-1, same convention already established
    for compare_suppliers' overallScore. confidence is None only when
    status is NOT_FOUND - nothing plausible was found to score at all, so
    there is no real number to report. candidates is populated (top 2-3
    by score) only when status is AMBIGUOUS - e.g. a real, confirmed case:
    raw text "Office" scores 90.0 against BOTH "Office Headset" and
    "Office Chair" in this catalog, an exact tie between two real,
    plausible products.
    """

    productNameRaw: str
    status: ProductMatchStatus
    productId: Optional[int] = None
    productName: Optional[str] = None
    confidence: Optional[float] = Field(None, ge=0, le=100, description="rapidfuzz WRatio score. None only when status is NOT_FOUND.")
    candidates: list[ProductMatchCandidate] = Field(
        default_factory=list, description="Top 2-3 scored candidates, populated only when status is AMBIGUOUS."
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


class SupplierMatchCandidate(BaseModel):
    """One scored candidate, used only in FindSupplierResponse.candidates (AMBIGUOUS only)."""

    supplierId: int
    supplierName: str
    score: float = Field(..., ge=0, le=100, description="rapidfuzz WRatio score, native 0-100 scale - not rescaled.")


class FindSupplierResponse(BaseModel):
    """See ProductMatch's docstring - same confidence/candidates convention
    (native 0-100 rapidfuzz scale, confidence None only for NOT_FOUND,
    candidates populated only for AMBIGUOUS).
    """

    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    extractedSupplierName: str
    status: SupplierMatchStatus
    supplierId: Optional[int] = None
    supplierName: Optional[str] = None
    confidence: Optional[float] = Field(None, ge=0, le=100, description="rapidfuzz WRatio score. None only when status is NOT_FOUND.")
    candidates: list[SupplierMatchCandidate] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# match_invoice_to_po (invoice branch only)
# ---------------------------------------------------------------------------


class PoMatchStatus(str, Enum):
    MATCHED = "MATCHED"
    NO_MATCH = "NO_MATCH"
    MULTIPLE_CANDIDATES = "MULTIPLE_CANDIDATES"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


class PoCandidate(BaseModel):
    """One candidate PO, used only in MatchInvoiceToPoResponse.candidates (MULTIPLE_CANDIDATES only)."""

    purchaseOrderId: int
    total: float = Field(
        ...,
        description=(
            "Real PO total - quantity * price summed across items. Every INCOMING transaction "
            "item is guaranteed a price at creation, so this is always a complete total."
        ),
    )
    expectedDate: Optional[datetime] = None


class MatchInvoiceToPoResponse(BaseModel):
    """No invented "confidence" score - a total-amount comparison isn't a
    probabilistic text match the way ProductMatch's rapidfuzz score is, so
    the real numbers (extractedTotal/purchaseOrderTotal/amountDifference)
    are reported directly instead of behind one invented figure.
    extractedTotal is None only when status is INSUFFICIENT_DATA (no
    extracted line item had a price at all - nothing real to sum).
    purchaseOrderTotal/amountDifference are set only when status is
    MATCHED (a single PO was found within tolerance). See
    agents/document_agent/tools.py::match_invoice_to_po for the tolerance
    (2% of the larger total, or $1.00, whichever is greater - a reasoned
    default, NOT empirically calibrated against real data the way
    rapidfuzz's thresholds were: real seed data only has two PENDING
    INCOMING POs total, nowhere near enough diversity to derive a
    threshold from evidence - see the wiring investigation).
    """

    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    status: PoMatchStatus
    purchaseOrderId: Optional[int] = None
    extractedTotal: Optional[float] = Field(
        None, description="Sum of quantity*unitPrice across extractedItems that have a price. None only when status is INSUFFICIENT_DATA."
    )
    purchaseOrderTotal: Optional[float] = Field(None, description="The matched PO's real total. Set only when status is MATCHED.")
    amountDifference: Optional[float] = Field(
        None, description="extractedTotal - purchaseOrderTotal. Set only when status is MATCHED."
    )
    candidates: list[PoCandidate] = Field(
        default_factory=list, description="Top real POs within tolerance, populated only when status is MULTIPLE_CANDIDATES."
    )


# ---------------------------------------------------------------------------
# choose_fulfillment_warehouse (order branch only)
# ---------------------------------------------------------------------------


class WarehouseSelectionStatus(str, Enum):
    RECOMMENDED = "RECOMMENDED"
    NO_ELIGIBLE_WAREHOUSE = "NO_ELIGIBLE_WAREHOUSE"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


class WarehouseCandidate(BaseModel):
    """Every candidate here is already stock-eligible for the FULL order
    (every line item, at the requested quantity) - that's the real
    correctness filter from GET/POST /warehouse-routing/eligible-warehouses,
    so there is no "canFullyFulfill" field here the way the old mocked
    schema had one - it would always be true by construction. distanceKm
    is real, from POST /path-optimizer/nearest-warehouse's geocoding - not
    a fabricated 0-1 "distanceScore" the way the old mocked schema had.
    """

    warehouseId: int
    warehouseName: str
    distanceKm: Optional[float] = Field(
        None, description="Real great-circle distance from the delivery destination, in km. None only when distanceUnconfirmed is true."
    )
    distanceUnconfirmed: bool = Field(
        False,
        description=(
            "True when this warehouse's real distance could not be determined (geocoding failed, or the "
            "distance-lookup call itself failed) - it may still be recommended if no better-confirmed "
            "alternative exists, but the choice is not distance-verified."
        ),
    )
    minRemainingMargin: int = Field(
        ...,
        description=(
            "The smallest (available - requestedQuantity) across every order line item at this warehouse - "
            "how much stock headroom this warehouse has on its TIGHTEST item, not an average. This is the "
            "tiebreak criterion when two or more eligible warehouses are within 50km of each other."
        ),
    )


class ChooseFulfillmentWarehouseResponse(BaseModel):
    """status is RECOMMENDED only when at least one real, stock-eligible
    warehouse was found and selected. NO_ELIGIBLE_WAREHOUSE means
    POST /warehouse-routing/eligible-warehouses genuinely returned zero
    warehouses that can fully stock every requested line item - a real,
    honest answer, not a fallback to a partial match. INSUFFICIENT_DATA
    means none of the order's extracted line items could even be resolved
    to a real productId (see unresolvedItems) - there was nothing real to
    check eligibility for at all. recommendedWarehouseId/Name are None for
    both non-RECOMMENDED statuses.
    """

    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    status: WarehouseSelectionStatus
    recommendedWarehouseId: Optional[int] = None
    recommendedWarehouseName: Optional[str] = None
    reason: str = Field(..., description="Deterministic, built in Python from real data - never left to the model to invent.")
    unresolvedItems: list[str] = Field(
        default_factory=list,
        description=(
            "Raw extracted product names that could not be resolved to a real productId - excluded from the "
            "eligibility check. Any recommendation is INCOMPLETE if this is non-empty; those items were never "
            "actually checked against warehouse stock."
        ),
    )
    candidates: list[WarehouseCandidate] = Field(
        default_factory=list,
        description="Every stock-eligible warehouse for the full order (not just the winner), each with real distance/margin data.",
    )


# ---------------------------------------------------------------------------
# detect_duplicate_document
#
# Advisory similarity evidence for currently pending reviews. The backend
# has no exact-file hash/invoice-number primitive and no list-all history
# endpoint, so this contract intentionally does not assert exact identity.
# ---------------------------------------------------------------------------


class DuplicateMatch(BaseModel):
    """No invented "similarityScore" - see
    agents/document_agent/tools.py::detect_duplicate_document for the real
    signal-based comparison (4 real signals, >= 3 agreeing surfaces a
    potential candidate). matchedOn lists exactly which real signals agreed, e.g.
    ["supplier", "date", "total"] - itemOverlapRatio is the one genuinely
    well-defined real number here (Jaccard ratio of resolved productId
    sets), kept as its own field rather than folded into an opaque score.
    extractedIdentityName/extractedDate/totalValue are the CANDIDATE's own
    real values, given directly for human comparison rather than hidden
    behind a match/no-match verdict.
    """

    documentReviewId: int
    matchedOn: list[str] = Field(..., description="Which of the 4 real signals agreed, e.g. ['supplier', 'date', 'total'].")
    extractedIdentityName: Optional[str] = Field(
        None, description="The candidate's own extractedSupplierName (invoice) or extractedPartyName (order)."
    )
    extractedDate: Optional[datetime] = None
    totalValue: Optional[float] = Field(None, description="The candidate's own real total - quantity*price summed across extractedItems that have a price.")
    itemOverlapRatio: Optional[float] = Field(
        None, ge=0, le=1, description="Jaccard ratio of the two documents' resolved productId sets - real, not fabricated. None if neither document has a resolvable item."
    )


class DuplicateCheckStatus(str, Enum):
    NO_SIMILAR_PENDING_REVIEW = "NO_SIMILAR_PENDING_REVIEW"
    POTENTIAL_DUPLICATE_REVIEW = "POTENTIAL_DUPLICATE_REVIEW"


class DetectDuplicateDocumentResponse(BaseModel):
    documentId: str = Field(..., description="Echoes the input document_id, for traceability.")
    status: DuplicateCheckStatus
    isPotentialDuplicate: bool = Field(
        ...,
        description="Advisory only; never proof that the underlying file is an exact duplicate.",
    )
    scope: Literal["PENDING_REVIEWS_ONLY"] = "PENDING_REVIEWS_ONLY"
    evidenceLimitations: str
    matches: list[DuplicateMatch] = Field(
        default_factory=list,
        description="Similar same-type pending reviews, sorted by most agreeing signals.",
    )


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
    """SUPPLIER_MISMATCH's productId/productName are always None (it's a
    document-level check, not a line-item one) - expectedValue/actualValue
    carry the two supplierIds being compared instead. For the other four
    types, productId is None only when a raw extracted line item's name
    could not be resolved to any real product at all (UNEXPECTED_LINE_ITEM
    with productName holding the raw, unresolved text) - see
    agents/document_agent/tools.py::detect_discrepancy.
    """

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
        None, description="e.g. 'purchaseOrderId=482' - deterministically built from the real po_id input, never a free-form caller string."
    )
