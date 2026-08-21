"""Real NestJS document-review tools for the Document Agent."""

from __future__ import annotations

from typing import Optional

from strands import tool

from clients import BackendHttpClient
from tools.schemas.document_schema import (
    ApproveDocumentReviewRequest,
    DocumentReviewDetail,
    PendingDocumentReviewsResponse,
    ProductResolutionResponse,
    RejectDocumentReviewRequest,
    SupplierResolutionResponse,
)


@tool
def get_pending_document_reviews() -> dict:
    """List real document reviews still awaiting a human decision."""
    rows = BackendHttpClient().get("/document-review/pending")
    return PendingDocumentReviewsResponse.model_validate(
        {"reviews": rows}
    ).model_dump(mode="json")


@tool
def get_document_review(review_id: int) -> dict:
    """Get one document review, including extraction, audit, and resulting transaction data."""
    row = BackendHttpClient().get(f"/document-review/{review_id}")
    return DocumentReviewDetail.model_validate(row).model_dump(mode="json")


@tool
def resolve_document_product(query: str) -> dict:
    """Get backend-generated active-product suggestions for an extracted product name."""
    rows = BackendHttpClient().get(
        "/document-review/resolve-product",
        query={"query": query},
    )
    return ProductResolutionResponse.model_validate(
        {"query": query, "suggestions": rows}
    ).model_dump(mode="json")


@tool
def resolve_document_supplier(query: str) -> dict:
    """Get backend-generated active-supplier suggestions for an extracted supplier name."""
    rows = BackendHttpClient().get(
        "/document-review/resolve-supplier",
        query={"query": query},
    )
    return SupplierResolutionResponse.model_validate(
        {"query": query, "suggestions": rows}
    ).model_dump(mode="json")


@tool
def approve_document_review(
    review_id: int,
    items: list[dict],
    expected_date: Optional[str] = None,
    supplier_id: Optional[int] = None,
    destination_warehouse_id: Optional[int] = None,
    source_warehouse_id: Optional[int] = None,
    party_name: Optional[str] = None,
    delivery_country: Optional[str] = None,
    delivery_region: Optional[str] = None,
    delivery_address: Optional[str] = None,
) -> dict:
    """Approve a review through NestJS so it creates the real PENDING transaction.

    INCOMING reviews require supplier_id and destination_warehouse_id.
    OUTGOING reviews require source_warehouse_id. Each confirmed item must
    contain productId and quantity, with optional price. The authenticated
    JWT determines reviewedById; this tool never accepts or sends it.
    """
    request = ApproveDocumentReviewRequest.model_validate(
        {
            "items": items,
            "expectedDate": expected_date,
            "supplierId": supplier_id,
            "destinationWarehouseId": destination_warehouse_id,
            "sourceWarehouseId": source_warehouse_id,
            "partyName": party_name,
            "deliveryCountry": delivery_country,
            "deliveryRegion": delivery_region,
            "deliveryAddress": delivery_address,
        }
    )
    row = BackendHttpClient().post(
        f"/document-review/{review_id}/approve",
        json_body=request.model_dump(mode="json", exclude_none=True),
    )
    return DocumentReviewDetail.model_validate(row).model_dump(mode="json")


@tool
def reject_document_review(review_id: int, rejection_reason: str) -> dict:
    """Reject a pending review through NestJS while preserving its audit trail."""
    request = RejectDocumentReviewRequest.model_validate(
        {"rejectionReason": rejection_reason}
    )
    row = BackendHttpClient().post(
        f"/document-review/{review_id}/reject",
        json_body=request.model_dump(mode="json"),
    )
    return DocumentReviewDetail.model_validate(row).model_dump(mode="json")
