"""Document processing tools for the Strands Agent.

Every function is decorated with @tool. Bodies are MOCKED - they call into
tools/mocks/document_mock_data.py and validate the result against
tools/schemas/document_schema.py before returning a plain dict. No real
extraction/OCR or database call happens here.

extract_document() is the entry point and routes internally to exactly one
of two branches (invoice or order) based on the caller-supplied `doc_type` -
it never guesses the type itself. See agents/document_agent/prompts.py for
the branching rules the agent must follow after extraction.

Every tool below requires `document_id` as its first argument. This is a
deliberate fix for a real bug: these tools used to accept no document
reference (or an unvalidated one) and would return a plausible-looking
mocked result even when called with no real document in play, which reads
as a confident, fabricated answer. Now, every mock validates document_id
against a small known-document set and raises DocumentNotFoundError - which
Strands turns into a proper tool error result - when it isn't recognized.
See tools/mocks/document_mock_data.py.
"""

from __future__ import annotations

from typing import Literal

from strands import tool

from tools.mocks import document_mock_data as mocks
from tools.schemas.document_schema import (
    ChooseFulfillmentWarehouseResponse,
    DetectDiscrepancyResponse,
    DetectDuplicateDocumentResponse,
    ExtractDocumentResponse,
    FindCustomerResponse,
    FindSupplierResponse,
    MatchInvoiceToPoResponse,
    MatchProductsResponse,
)


@tool
def extract_document(document_id: str, doc_type: Literal["invoice", "order"]) -> dict:
    """Extract structured data from a specific uploaded document.

    Routes internally to exactly one branch based on `doc_type` and NEVER
    calls both: "invoice" extracts supplier/PO-oriented fields (INCOMING
    stock), "order" extracts customer/fulfillment-oriented fields (OUTGOING
    stock). doc_type is provided by the upload step - never guess it
    yourself from the document content.

    Args:
        document_id: The specific document's ID, as provided by the upload
            step or the user. Never invent or guess this value - if you
            don't have a real document_id, ask the user for one instead of
            calling this tool.
        doc_type: Either "invoice" (incoming stock from a supplier) or
            "order" (outgoing stock to a customer). Always supplied
            upstream by the upload step.

    Returns:
        A dict with the extracted fields for the given doc_type: line
        items, and either supplier-side fields (invoice) or customer-side
        fields (order).

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    if doc_type not in ("invoice", "order"):  # pragma: no cover - Literal type hint already constrains this
        raise ValueError(f"Unknown doc_type: {doc_type!r}")

    raw = mocks.extract_document_mock(document_id=document_id, doc_type=doc_type)
    return ExtractDocumentResponse.model_validate(raw).model_dump(mode="json")


@tool
def match_products(document_id: str, product_names: list[str]) -> dict:
    """Match raw, extracted product name strings against the product catalog.

    Used by BOTH the invoice and order branches.

    Args:
        document_id: The document these product names were extracted from -
            must be a real document_id from a prior extract_document() call.
        product_names: The raw productNameRaw strings from extract_document()'s extractedItems.

    Returns:
        A dict with a `matches` list. Each match has a `status`
        (MATCHED/AMBIGUOUS/NOT_FOUND) and, when matched, the resolved
        productId/productName.

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    return MatchProductsResponse.model_validate(
        mocks.match_products_mock(document_id=document_id, product_names=product_names)
    ).model_dump(mode="json")


@tool
def find_supplier(document_id: str, supplier_name: str) -> dict:
    """Match an extracted supplier name against the supplier catalog. INVOICE BRANCH ONLY.

    Do not call this for an "order" doc_type - use find_customer() instead.

    Args:
        document_id: The invoice document this supplier name was extracted
            from - must be a real document_id from a prior extract_document() call.
        supplier_name: The extractedSupplierName from extract_document().

    Returns:
        A dict with a `status` (MATCHED/AMBIGUOUS/NOT_FOUND) and, when
        matched, the resolved supplierId/supplierName.

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    return FindSupplierResponse.model_validate(
        mocks.find_supplier_mock(document_id=document_id, supplier_name=supplier_name)
    ).model_dump(mode="json")


@tool
def match_invoice_to_po(document_id: str, supplier_id: int, extracted_total: float) -> dict:
    """Try to match this invoice against an existing open purchase order for the same supplier. INVOICE BRANCH ONLY.

    Do not call this for an "order" doc_type.

    Args:
        document_id: The invoice document to match - must be a real
            document_id from a prior extract_document() call. Never call
            this with a guessed or invented document_id, even if the rest
            of the invoice's details (supplier, total) seem clear from
            context.
        supplier_id: The matched supplier's database ID (from find_supplier()).
        extracted_total: The invoice's total amount, used to narrow candidate POs.

    Returns:
        A dict with a `status` (MATCHED/NO_MATCH/MULTIPLE_CANDIDATES) and,
        when matched, the purchaseOrderId.

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    return MatchInvoiceToPoResponse.model_validate(
        mocks.match_invoice_to_po_mock(
            document_id=document_id, supplier_id=supplier_id, extracted_total=extracted_total
        )
    ).model_dump(mode="json")


@tool
def find_customer(document_id: str, party_name: str) -> dict:
    """Match an extracted customer/party name against the customer records. ORDER BRANCH ONLY.

    Do not call this for an "invoice" doc_type - use find_supplier() instead.

    Args:
        document_id: The order document this party name was extracted from -
            must be a real document_id from a prior extract_document() call.
        party_name: The extractedPartyName from extract_document().

    Returns:
        A dict with a `status` (MATCHED/AMBIGUOUS/NOT_FOUND/NEW_CUSTOMER)
        and, when matched, the resolved customerId/customerName.

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    return FindCustomerResponse.model_validate(
        mocks.find_customer_mock(document_id=document_id, party_name=party_name)
    ).model_dump(mode="json")


@tool
def choose_fulfillment_warehouse(document_id: str, product_ids: list[int], delivery_region: str) -> dict:
    """Choose which warehouse should fulfill this order. ORDER BRANCH ONLY.

    Do not call this for an "invoice" doc_type.

    Args:
        document_id: The order document being fulfilled - must be a real
            document_id from a prior extract_document() call.
        product_ids: The matched productIds for this order's line items.
        delivery_region: The extractedDeliveryRegion from extract_document().

    Returns:
        A dict with the recommendedWarehouseId/Name, a reason, and the
        full list of candidate warehouses considered.

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    return ChooseFulfillmentWarehouseResponse.model_validate(
        mocks.choose_fulfillment_warehouse_mock(
            document_id=document_id, product_ids=product_ids, delivery_region=delivery_region
        )
    ).model_dump(mode="json")


@tool
def detect_duplicate_document(document_id: str) -> dict:
    """Check whether THIS EXACT DOCUMENT has already been submitted/processed before (a re-upload, resent attachment, etc.).

    This is about document identity, not content: it answers "have we seen
    this document before", never "does this document's data match what we
    expected" - that second question is detect_discrepancy()'s job, not
    this tool's. Used by BOTH the invoice and order branches, typically as
    a final check before reporting a result.

    Args:
        document_id: The document to check - must be a real document_id
            from a prior extract_document() call.

    Returns:
        A dict with `isDuplicate` and, when true, a `matches` list
        describing which prior document(s) it matches and on what fields.

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    return DetectDuplicateDocumentResponse.model_validate(
        mocks.detect_duplicate_document_mock(document_id=document_id, is_duplicate=False)
    ).model_dump(mode="json")


@tool
def detect_discrepancy(document_id: str, compare_against: str) -> dict:
    """Compare THIS DOCUMENT'S DATA (quantities, prices, line items) against the record it should match (a PO for invoices, an order for orders).

    This is about content mismatches, not document identity: it answers
    "does this document's data match what we expected", never "have we
    already processed this exact document" - that second question is
    detect_duplicate_document()'s job, not this tool's. Used by BOTH the
    invoice and order branches, typically as a final check before reporting
    a result.

    Args:
        document_id: The document to check - must be a real document_id
            from a prior extract_document() call.
        compare_against: An identifier for what to compare against, e.g.
            "purchaseOrderId=482".

    Returns:
        A dict with `hasDiscrepancies` and a `discrepancies` list (type,
        expected vs. actual value, severity) when true.

    Raises:
        DocumentNotFoundError: If document_id doesn't match a real,
            previously-uploaded document.
    """
    return DetectDiscrepancyResponse.model_validate(
        mocks.detect_discrepancy_mock(document_id=document_id, has_discrepancies=False)
    ).model_dump(mode="json")
