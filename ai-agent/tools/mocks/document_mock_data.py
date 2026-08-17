"""Mocked backend responses for every Document tool.

Shapes mirror tools/schemas/document_schema.py. Two branches are covered
throughout: "invoice" (INCOMING transaction, from a supplier) and "order"
(OUTGOING transaction, to a customer) - matching the backend's
InventoryTransactionType enum. A duplicate-detection example and a
discrepancy-detection example are included, as required for the smoke tests.

Every function below takes `document_id` as its first argument and
validates it against `_MOCK_DOCUMENTS` before returning anything, raising
DocumentNotFoundError otherwise. This exists to close a real bug: a tool
called with a fabricated or missing document reference used to fall back to
a plausible-looking default record instead of failing, so a confident,
fully made-up answer was indistinguishable from a real one. Now, operating
on a document_id that was never obtained from a real extract_document()
call (or from the user) fails loudly instead of quietly succeeding - see
agents/document_agent/prompts.py rule 4 for the corresponding prompt-level
guidance, and tools/schemas/document_schema.py for the `documentId` field
every success response now echoes back for traceability.
"""

from __future__ import annotations

from datetime import datetime, timedelta

_NOW = datetime(2026, 8, 15, 9, 0, 0)

# Known mock "documents", keyed by document_id. In the real system this
# would be a lookup against whatever store the upload step wrote to; here
# it's the entire fake universe of documents these mocks know about.
KNOWN_INVOICE_DOCUMENT_ID = "doc_inv_2026_0815_001"
KNOWN_ORDER_DOCUMENT_ID = "doc_ord_2026_0815_001"

_MOCK_DOCUMENTS: dict[str, dict] = {
    KNOWN_INVOICE_DOCUMENT_ID: {
        "docType": "invoice",
        "extractedPartyName": None,
        "extractedSupplierName": "Nordic Components AB",
        "extractedDate": (_NOW - timedelta(days=1)).isoformat(),
        "extractedWarehouseName": "London Central",
        "extractedDeliveryCountry": "United Kingdom",
        "extractedDeliveryRegion": "London",
        "extractedItems": [
            {"productNameRaw": "USB-C Docking Station 100W", "quantity": 60, "unitPrice": 34.50},
            {"productNameRaw": "Wireless Optical Mouse", "quantity": 30, "unitPrice": 8.20},
        ],
        "documentUrl": "s3://erp-documents/invoices/inv-2026-0815-nordic.pdf",
    },
    KNOWN_ORDER_DOCUMENT_ID: {
        "docType": "order",
        "extractedPartyName": "Bluewater Retail Group",
        "extractedSupplierName": None,
        "extractedDate": _NOW.isoformat(),
        "extractedWarehouseName": None,
        "extractedDeliveryCountry": "United Kingdom",
        "extractedDeliveryRegion": "Greater Manchester",
        "extractedItems": [
            {"productNameRaw": "27in Monitor", "quantity": 12, "unitPrice": 189.00},
            {"productNameRaw": "Mechanical Keyboard", "quantity": 25, "unitPrice": 55.00},
        ],
        "documentUrl": "s3://erp-documents/orders/ord-2026-0815-bluewater.pdf",
    },
}


class DocumentNotFoundError(LookupError):
    """Raised by every mock function below when document_id isn't a known mock document.

    Deliberately a raised exception, not a returned "not found" dict: the
    Strands @tool decorator automatically turns a raised exception into an
    error tool result (status="error") that the calling agent sees as a
    genuine tool failure - the same mechanism already used for an invalid
    doc_type in extract_document(). This makes the failure impossible for
    the agent to quietly narrate past.
    """


def _require_known_document(document_id: str) -> dict:
    """Look up document_id in the mock dataset or raise DocumentNotFoundError.

    Every mock function below calls this first, before doing anything else.
    """
    document = _MOCK_DOCUMENTS.get(document_id)
    if document is None:
        raise DocumentNotFoundError(
            f"No document found for document_id={document_id!r}. "
            "Do not guess or fabricate a document_id - it must come from a "
            "real extract_document() response or from the user."
        )
    return document


# ---------------------------------------------------------------------------
# extract_document
# ---------------------------------------------------------------------------


def extract_document_mock(document_id: str, doc_type: str) -> dict:
    document = _require_known_document(document_id)
    return {"documentId": document_id, **document}


# ---------------------------------------------------------------------------
# match_products
# ---------------------------------------------------------------------------


def match_products_mock(document_id: str, product_names: list[str]) -> dict:
    _require_known_document(document_id)

    catalog = {
        "usb-c docking station 100w": (102, "USB-C Docking Station"),
        "wireless optical mouse": (101, "Wireless Mouse"),
        "27in monitor": (103, "27in Monitor"),
        "mechanical keyboard": (108, "Mechanical Keyboard"),
    }
    matches = []
    for raw in product_names:
        hit = catalog.get(raw.strip().lower())
        if hit:
            matches.append(
                {
                    "productNameRaw": raw,
                    "status": "MATCHED",
                    "productId": hit[0],
                    "productName": hit[1],
                    "confidence": 0.96,
                    "candidates": [],
                }
            )
        else:
            matches.append(
                {
                    "productNameRaw": raw,
                    "status": "NOT_FOUND",
                    "productId": None,
                    "productName": None,
                    "confidence": 0.0,
                    "candidates": [],
                }
            )
    return {"documentId": document_id, "matches": matches}


# ---------------------------------------------------------------------------
# find_supplier (invoice branch only)
# ---------------------------------------------------------------------------


def find_supplier_mock(document_id: str, supplier_name: str) -> dict:
    _require_known_document(document_id)
    return {
        "documentId": document_id,
        "extractedSupplierName": supplier_name,
        "status": "MATCHED",
        "supplierId": 5,
        "supplierName": "Nordic Components AB",
        "confidence": 0.99,
        "candidates": [],
    }


# ---------------------------------------------------------------------------
# match_invoice_to_po (invoice branch only)
# ---------------------------------------------------------------------------


def match_invoice_to_po_mock(document_id: str, supplier_id: int, extracted_total: float) -> dict:
    _require_known_document(document_id)
    return {
        "documentId": document_id,
        "status": "MATCHED",
        "purchaseOrderId": 482,
        "confidence": 0.93,
        "candidatePurchaseOrderIds": [],
    }


# ---------------------------------------------------------------------------
# find_customer (order branch only)
# ---------------------------------------------------------------------------


def find_customer_mock(document_id: str, party_name: str) -> dict:
    _require_known_document(document_id)
    return {
        "documentId": document_id,
        "extractedPartyName": party_name,
        "status": "MATCHED",
        "customerId": 44,
        "customerName": "Bluewater Retail Group",
        "confidence": 0.95,
    }


# ---------------------------------------------------------------------------
# choose_fulfillment_warehouse (order branch only)
# ---------------------------------------------------------------------------


def choose_fulfillment_warehouse_mock(
    document_id: str, product_ids: list[int], delivery_region: str
) -> dict:
    _require_known_document(document_id)
    return {
        "documentId": document_id,
        "recommendedWarehouseId": 2,
        "recommendedWarehouseName": "Manchester North",
        "reason": "Only warehouse with full stock coverage for all requested line items and closest to delivery region.",
        "candidates": [
            {
                "warehouseId": 2,
                "warehouseName": "Manchester North",
                "canFullyFulfill": True,
                "distanceScore": 0.92,
            },
            {
                "warehouseId": 1,
                "warehouseName": "London Central",
                "canFullyFulfill": False,
                "distanceScore": 0.41,
            },
        ],
    }


# ---------------------------------------------------------------------------
# detect_duplicate_document - "has THIS document already been processed
# before?" See tools/schemas/document_schema.py for how this differs from
# detect_discrepancy.
# ---------------------------------------------------------------------------


def detect_duplicate_document_mock(document_id: str, is_duplicate: bool = False) -> dict:
    """Example toggle: pass is_duplicate=True to exercise the duplicate case."""
    _require_known_document(document_id)

    if not is_duplicate:
        return {"documentId": document_id, "isDuplicate": False, "matches": []}

    return {
        "documentId": document_id,
        "isDuplicate": True,
        "matches": [
            {
                "documentReviewId": 917,
                "similarityScore": 0.98,
                "matchedOn": ["supplierName", "totalAmount", "date", "lineItemCount"],
            },
        ],
    }


# ---------------------------------------------------------------------------
# detect_discrepancy - "does THIS document's data match what we expected?"
# See tools/schemas/document_schema.py for how this differs from
# detect_duplicate_document.
# ---------------------------------------------------------------------------


def detect_discrepancy_mock(document_id: str, has_discrepancies: bool = False) -> dict:
    """Example toggle: pass has_discrepancies=True to exercise the discrepancy case."""
    _require_known_document(document_id)

    if not has_discrepancies:
        return {
            "documentId": document_id,
            "hasDiscrepancies": False,
            "discrepancies": [],
            "comparedAgainst": "purchaseOrderId=482",
        }

    return {
        "documentId": document_id,
        "hasDiscrepancies": True,
        "discrepancies": [
            {
                "type": "QUANTITY_MISMATCH",
                "productId": 102,
                "productName": "USB-C Docking Station",
                "expectedValue": "50",
                "actualValue": "60",
                "severity": "MEDIUM",
            },
            {
                "type": "PRICE_MISMATCH",
                "productId": 101,
                "productName": "Wireless Mouse",
                "expectedValue": "7.50",
                "actualValue": "8.20",
                "severity": "LOW",
            },
        ],
        "comparedAgainst": "purchaseOrderId=482",
    }
