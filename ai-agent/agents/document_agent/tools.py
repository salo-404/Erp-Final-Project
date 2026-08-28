"""Document processing tools for the Strands Agent.

The active runtime registry lives in ``agents/document_agent/agent.py`` and
contains exactly: get_pending_document_reviews, get_document_review,
resolve_document_product, resolve_document_supplier, approve_document_review,
reject_document_review, and detect_duplicate_document.

Legacy helpers including extract_document, match_products, find_supplier,
match_invoice_to_po, detect_discrepancy, and choose_fulfillment_warehouse
are intentionally retained for direct regression-test compatibility. They are
not registered with the Document runtime and are not an alternate extraction
or conversational tool path.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from rapidfuzz import fuzz, utils
from strands import tool

from backend_client import (
    BackendClient,
    HumanAuthenticatedBackendClient,
    get_backend_client,
)
from request_context import get_human_bearer_token
from tools.schemas.document_schema import (
    ChooseFulfillmentWarehouseResponse,
    DetectDiscrepancyResponse,
    DetectDuplicateDocumentResponse,
    DocumentReviewDecisionResponse,
    DocumentReviewRecord,
    ExtractDocumentResponse,
    FindSupplierResponse,
    MatchInvoiceToPoResponse,
    MatchProductsResponse,
    PendingDocumentReviewsResponse,
    ResolveDocumentProductResponse,
    ResolveDocumentSupplierResponse,
)


class DocumentReviewAuthorizationRequired(RuntimeError):
    """Raised when an ADMIN-authenticated review decision cannot be made."""

# Classification thresholds for _classify_fuzzy_match(), validated against
# the real product/supplier catalog before adopting (see the wiring
# investigation report) - not guesses. rapidfuzz.fuzz.WRatio's native scale
# is 0-100. Real evidence: every genuine match tested (typos, transposed
# letters, reordered words, extra/missing words, abbreviations) scored
# 85.5-100; every genuinely unrelated text scored 40.0-42.4 - a 43-point
# gap with no real data in between, so 80/60 sit with comfortable margin
# on both sides.
_MATCH_THRESHOLD = 80.0
_AMBIGUOUS_FLOOR = 60.0
_AMBIGUOUS_GAP = 8.0

# Tolerance for comparing two real dollar amounts (a PO total vs an
# extracted invoice total in match_invoice_to_po, or a PO line's unit price
# vs an extracted line's unit price in detect_discrepancy): 2% of the
# larger amount, or $1.00, whichever is greater - a common AP three-way-
# match convention (covers rounding/negotiated-price drift). Unlike
# _MATCH_THRESHOLD etc. above, this is a REASONED DEFAULT, NOT empirically
# calibrated against real data: real seed data has only two PENDING
# INCOMING purchase orders total (one per supplier), nowhere near enough
# diversity to derive a threshold from evidence the way rapidfuzz's real
# score distribution allowed. Flagged explicitly as a judgment call in the
# wiring investigation - revisit if real invoice/PO variance data ever
# becomes available.
_PO_TOLERANCE_PERCENT = 0.02
_PO_TOLERANCE_FLOOR = 1.00


def _po_amount_tolerance(a: float, b: float) -> float:
    return max(_PO_TOLERANCE_PERCENT * max(a, b), _PO_TOLERANCE_FLOOR)


def _map_extracted_items(raw_items: list[dict]) -> list[dict]:
    """Reshape real extractedItems entries ({product, quantity, price?}) to
    the AI schema's line-item fields (productNameRaw, quantity, unitPrice).

    price is optional in the real data (PendingDocumentReview.extractedItems
    is a Json blob with no schema-enforced shape beyond what upload-time
    extraction happened to produce) - an entry with no price maps to
    unitPrice: None via dict.get(), never fabricated as 0.
    """
    return [
        {
            "productNameRaw": item["product"],
            "quantity": item["quantity"],
            "unitPrice": item.get("price"),
        }
        for item in raw_items
    ]


def _numeric_review_id(document_id: str) -> int:
    try:
        return int(document_id)
    except ValueError as exc:
        raise ValueError(
            f"document_id must be a real numeric PendingDocumentReview id, got {document_id!r}"
        ) from exc


@tool
async def get_pending_document_reviews() -> dict:
    """Return real PendingDocumentReview rows still awaiting human review."""
    client = get_backend_client()
    reviews = await client.get("/document-review/pending")
    return PendingDocumentReviewsResponse.model_validate(
        {"reviews": reviews}
    ).model_dump(mode="json")


@tool
async def get_document_review(document_id: str) -> dict:
    """Fetch one real document-review record; raw extraction already occurred upstream."""
    client = get_backend_client()
    review = await client.get(f"/document-review/{_numeric_review_id(document_id)}")
    return DocumentReviewRecord.model_validate(review).model_dump(mode="json")


@tool
async def resolve_document_product(
    document_id: str,
    product_name: str,
) -> dict:
    """Get authoritative backend Product suggestions for one extracted line item.

    A product is marked RESOLVED only for one unique exact backend match.
    Partial/multiple suggestions remain advisory and require human resolution.
    requestedQuantity is derived from the stored review's extractedItems;
    it is never accepted from the model or caller.
    """
    review_id = _numeric_review_id(document_id)
    client = get_backend_client()
    review = DocumentReviewRecord.model_validate(
        await client.get(f"/document-review/{review_id}")
    )
    match_result = await client.get(
        "/document-review/resolve-product",
        params={"query": product_name},
    )
    candidates = match_result.get("candidates", [])
    resolved = candidates[0] if match_result.get("status") == "RESOLVED" and len(candidates) == 1 else None
    suggestions = [
        {
            "productId": candidate["id"],
            "name": candidate["name"],
            "score": candidate["confidence"],
        }
        for candidate in candidates
    ]
    matching_items = [
        item for item in review.extractedItems if item.product == product_name
    ]
    requested_quantity = (
        matching_items[0].quantity if len(matching_items) == 1 else None
    )
    return ResolveDocumentProductResponse.model_validate(
        {
            "documentId": document_id,
            "productNameRaw": product_name,
            "requestedQuantity": requested_quantity,
            "status": "RESOLVED" if resolved else ("AMBIGUOUS" if candidates else "NOT_FOUND"),
            "productId": resolved["id"] if resolved else None,
            "suggestions": suggestions,
        }
    ).model_dump(mode="json")


@tool
async def resolve_document_supplier(document_id: str, supplier_name: str) -> dict:
    """Get authoritative backend Supplier suggestions for an extracted supplier name."""
    review_id = _numeric_review_id(document_id)
    client = get_backend_client()
    DocumentReviewRecord.model_validate(
        await client.get(f"/document-review/{review_id}")
    )
    match_result = await client.get(
        "/document-review/resolve-supplier",
        params={"query": supplier_name},
    )
    candidates = match_result.get("candidates", [])
    resolved = candidates[0] if match_result.get("status") == "RESOLVED" and len(candidates) == 1 else None
    suggestions = [
        {
            "supplierId": candidate["id"],
            "name": candidate["name"],
            "score": candidate["confidence"],
        }
        for candidate in candidates
    ]
    return ResolveDocumentSupplierResponse.model_validate(
        {
            "documentId": document_id,
            "supplierNameRaw": supplier_name,
            "status": "RESOLVED" if resolved else ("AMBIGUOUS" if candidates else "NOT_FOUND"),
            "supplierId": resolved["id"] if resolved else None,
            "suggestions": suggestions,
        }
    ).model_dump(mode="json")


@tool
async def approve_document_review(
    document_id: str,
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
    """Approve a review as the authenticated human; the backend enforces ADMIN."""
    review_id = _numeric_review_id(document_id)
    bearer_token = get_human_bearer_token()
    if not bearer_token:
        raise DocumentReviewAuthorizationRequired(
            "Document approval requires an authenticated human ADMIN context; "
            "no approval occurred."
        )

    body = {"items": items}
    optional_fields = {
        "expectedDate": expected_date,
        "supplierId": supplier_id,
        "destinationWarehouseId": destination_warehouse_id,
        "sourceWarehouseId": source_warehouse_id,
        "partyName": party_name,
        "deliveryCountry": delivery_country,
        "deliveryRegion": delivery_region,
        "deliveryAddress": delivery_address,
    }
    body.update({key: value for key, value in optional_fields.items() if value is not None})
    result = await HumanAuthenticatedBackendClient(bearer_token).post(
        f"/document-review/{review_id}/approve",
        json=body,
    )
    return DocumentReviewDecisionResponse.model_validate(result).model_dump(mode="json")


@tool
async def reject_document_review(document_id: str, rejection_reason: str) -> dict:
    """Reject a review as the authenticated human; the backend enforces ADMIN."""
    review_id = _numeric_review_id(document_id)
    if not rejection_reason.strip():
        raise ValueError("rejection_reason must not be empty")
    bearer_token = get_human_bearer_token()
    if not bearer_token:
        raise DocumentReviewAuthorizationRequired(
            "Document rejection requires an authenticated human ADMIN context; "
            "no rejection occurred."
        )
    result = await HumanAuthenticatedBackendClient(bearer_token).post(
        f"/document-review/{review_id}/reject",
        json={"rejectionReason": rejection_reason},
    )
    return DocumentReviewDecisionResponse.model_validate(result).model_dump(mode="json")


@tool
async def extract_document(document_id: str) -> dict:
    """Fetch the already-extracted data for a specific uploaded document.

    This does NOT upload or extract anything itself - extraction already
    happened server-side when the document was uploaded (POST
    /document-review/upload, outside this tool's responsibility). This
    tool only fetches that already-extracted PendingDocumentReview row and
    reshapes it. docType is NOT a caller-supplied input (unlike the old
    mocked version) - it's derived from the real, already-decided
    transactionType on the row: INCOMING -> "invoice" (supplier/PO-
    oriented), OUTGOING -> "order" (customer/fulfillment-oriented). You
    never choose or guess docType; read it from this tool's response.

    Args:
        document_id: The specific document's database ID (as a string),
            from the upload step or the user. Never invent or guess this
            value - if you don't have a real document_id, ask the user for
            one instead of calling this tool.

    Returns:
        A dict with docType (derived, real - see above), status
        (PENDING_REVIEW/APPROVED/REJECTED), the extracted line items, and
        either supplier-side or customer-side fields depending on docType.

    Raises:
        ValueError: If document_id isn't a valid integer id.
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails - including NotFound when document_id doesn't match a real
        row. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool.
    """
    try:
        numeric_id = int(document_id)
    except ValueError as exc:
        raise ValueError(
            f"document_id must be a real numeric PendingDocumentReview id, got {document_id!r}"
        ) from exc

    client = get_backend_client()
    review = await client.get(f"/document-review/{numeric_id}")

    # Real upload-time validation (validateExtractedTransactionType in
    # document-review.service.ts) rejects any transactionType other than
    # INCOMING/OUTGOING before a review row can even be created, so this
    # two-way mapping is exhaustive - never a guess, never a third case.
    doc_type = "invoice" if review["transactionType"] == "INCOMING" else "order"
    items = _map_extracted_items(review["extractedItems"])

    result = {
        "documentId": str(review["id"]),
        "docType": doc_type,
        "status": review["status"],
        "extractedPartyName": review["extractedPartyName"],
        "extractedSupplierName": review["extractedSupplierName"],
        "extractedDate": review["extractedDate"],
        "extractedWarehouseName": review["extractedWarehouseName"],
        "extractedDeliveryCountry": review["extractedDeliveryCountry"],
        "extractedDeliveryRegion": review["extractedDeliveryRegion"],
        "extractedDeliveryAddress": review["extractedDeliveryAddress"],
        "extractedItems": items,
        "documentUrl": review["documentUrl"],
        "rejectionReason": review["rejectionReason"],
    }

    return ExtractDocumentResponse.model_validate(result).model_dump(mode="json")


def _classify_fuzzy_match(raw_text: str, candidates: list[dict]) -> dict:
    """Classify raw_text against a real candidate list using
    rapidfuzz.fuzz.WRatio(processor=utils.default_process) - the processor
    is required, not optional: without it, case/punctuation differences
    alone produce misleadingly low scores (confirmed in the wiring
    investigation - "USB-C Docking Station" vs "usb c docking station"
    scores 66.7 with no processor, 100.0 with default_process, for text
    that should obviously be treated as identical).

    candidates: [{"id": int, "name": str}, ...] - real catalog entries,
    generic key names so this one function serves both match_products()
    (products) and find_supplier() (suppliers) without duplicating the
    classification logic; each tool maps "id"/"name" to its own
    productId/productName or supplierId/supplierName field names.

    Thresholds (validated against real data, see _MATCH_THRESHOLD etc.
    above and the wiring investigation report):
      - MATCHED: top score >= 80, AND either there's no runner-up, the
        runner-up scores below 80, or the gap to the runner-up is >= 8.
      - AMBIGUOUS: top score in [60, 80) (a plausible-but-not-confident
        single candidate), OR top score >= 80 with a close runner-up
        (runner-up also >= 80 and gap < 8) - a real, confirmed case: raw
        text "Office" scores 90.0 against BOTH "Office Headset" and
        "Office Chair" in the real catalog, an exact tie between two
        genuinely plausible products.
      - NOT_FOUND: top score < 60.

    Returns {"status", "id", "name", "confidence", "candidates"} - id/name
    are set only when status is MATCHED; confidence is the top score,
    None only when status is NOT_FOUND (nothing plausible was found to
    score at all); candidates is the top 2-3 scored entries
    ({"id","name","score"}), populated only when status is AMBIGUOUS.

    KNOWN, ACCEPTED LIMITATION (confirmed in testing, not a bug to fix
    here): text similarity cannot distinguish semantically distinct but
    textually similar items - "Mouse Pad" scores 85.5 against "Wireless
    Mouse" (comfortably >= MATCHED) despite being a different, nonexistent
    product. This is why a MATCHED result must always be treated as a
    confident SUGGESTION, never a certainty - see this function's callers'
    docstrings and agents/document_agent/prompts.py.
    """
    if not candidates:
        return {"status": "NOT_FOUND", "id": None, "name": None, "confidence": None, "candidates": []}

    scored = sorted(
        (
            {
                "id": candidate["id"],
                "name": candidate["name"],
                "score": fuzz.WRatio(raw_text, candidate["name"], processor=utils.default_process),
            }
            for candidate in candidates
        ),
        key=lambda entry: entry["score"],
        reverse=True,
    )

    top = scored[0]
    second = scored[1] if len(scored) > 1 else None

    if top["score"] < _AMBIGUOUS_FLOOR:
        return {"status": "NOT_FOUND", "id": None, "name": None, "confidence": None, "candidates": []}

    has_close_runner_up = (
        second is not None and second["score"] >= _MATCH_THRESHOLD and (top["score"] - second["score"]) < _AMBIGUOUS_GAP
    )

    if top["score"] >= _MATCH_THRESHOLD and not has_close_runner_up:
        return {"status": "MATCHED", "id": top["id"], "name": top["name"], "confidence": top["score"], "candidates": []}

    return {
        "status": "AMBIGUOUS",
        "id": None,
        "name": None,
        "confidence": top["score"],
        "candidates": [{"id": entry["id"], "name": entry["name"], "score": entry["score"]} for entry in scored[:3]],
    }


async def _match_names_to_catalog(client: BackendClient, raw_names: list[str]) -> list[dict]:
    """Fetch the real ACTIVE product catalog once (GET /products) and
    classify each raw name against it via _classify_fuzzy_match() - the
    exact fetch+classify logic match_products() itself needs, factored out
    so detect_discrepancy() can also re-derive real productIds from raw
    extractedItems text, without duplicating this logic OR trusting
    productIds relayed through the calling agent's own conversation (the
    same "recompute deterministically, never trust agent-relayed derived
    data" principle already applied to match_invoice_to_po's extracted
    total below).

    Returns one classification dict per raw_names entry, in the same
    order - see _classify_fuzzy_match()'s own docstring for the exact
    shape ({"status","id","name","confidence","candidates"}).
    """
    products = await client.get("/products")
    candidates = [{"id": product["id"], "name": product["name"]} for product in products]
    return [_classify_fuzzy_match(raw_name, candidates) for raw_name in raw_names]


@tool
async def match_products(document_id: str, product_names: list[str]) -> dict:
    """Match raw, extracted product name strings against the real product catalog.

    Used by BOTH the invoice and order branches. Fetches the full ACTIVE
    product catalog once (GET /products - real scale confirmed small,
    single digits to low tens, so this is always cheap) and scores each
    input name against every real product with rapidfuzz - see
    _classify_fuzzy_match() for the full classification rules.

    IMPORTANT: a MATCHED result is a confident SUGGESTION, not a
    certainty. Text similarity can be fooled by a different-but-similar
    real-world item - e.g. "Mouse Pad" scores high enough to MATCH
    "Wireless Mouse" despite being a different product that may not even
    exist in the catalog as its own line. If the item's identity is at
    all unclear from context (an unusual raw name, a MATCHED result that
    seems surprising given the rest of the document), confirm with the
    user rather than proceeding as if it were certain - and never treat
    any match here as authorization to actually change anything: the
    real backend's approve() flow always requires a human to have
    separately confirmed the real productId before a transaction is
    created; this tool only ever produces a suggestion for that human
    step, the same way the backend's own resolveProduct() does.

    Args:
        document_id: The document these product names were extracted from.
            Always pass the real document_id for traceability - it is
            echoed back in the response - but unlike the other tools in
            this file, it is not looked up or validated here; matching
            runs against the live catalog, not per-document mock data.
        product_names: The raw productNameRaw strings from extract_document()'s extractedItems.

    Returns:
        A dict with a `matches` list, one entry per input name. Each has
        a `status` (MATCHED/AMBIGUOUS/NOT_FOUND), `confidence` (rapidfuzz's
        real 0-100 score; None only for NOT_FOUND), and either a resolved
        productId/productName (MATCHED) or a `candidates` list of the
        top 2-3 scored options (AMBIGUOUS) to put in front of the user.

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()
    classifications = await _match_names_to_catalog(client, product_names)

    matches = []
    for raw_name, classification in zip(product_names, classifications):
        matches.append(
            {
                "productNameRaw": raw_name,
                "status": classification["status"],
                "productId": classification["id"],
                "productName": classification["name"],
                "confidence": classification["confidence"],
                "candidates": [
                    {"productId": entry["id"], "productName": entry["name"], "score": entry["score"]}
                    for entry in classification["candidates"]
                ],
            }
        )

    return MatchProductsResponse.model_validate(
        {"documentId": document_id, "matches": matches}
    ).model_dump(mode="json")


@tool
async def find_supplier(document_id: str, supplier_name: str) -> dict:
    """Match an extracted supplier name against the real supplier catalog. INVOICE BRANCH ONLY.

    Do not call this for an "order" doc_type. Fetches the full ACTIVE
    supplier catalog once (GET /suppliers - real scale confirmed tiny,
    single digits) and scores supplier_name against every real supplier
    with rapidfuzz - see _classify_fuzzy_match() for the full
    classification rules.

    IMPORTANT: a MATCHED result is a confident SUGGESTION, not a
    certainty - see match_products()'s docstring for the same caveat and
    why (text similarity can be fooled by a different-but-similar real
    name). Confirm with the user if the supplier's identity is at all
    unclear from context, and never treat a match here as authorization
    to actually do anything - the real backend always requires a human
    to separately confirm the real supplierId before a purchase
    transaction is created; this tool only ever produces a suggestion.

    Args:
        document_id: The invoice document this supplier name was
            extracted from. Always pass the real document_id for
            traceability - it is echoed back in the response - but
            unlike the other tools in this file, it is not looked up or
            validated here; matching runs against the live catalog, not
            per-document mock data.
        supplier_name: The extractedSupplierName from extract_document().

    Returns:
        A dict with a `status` (MATCHED/AMBIGUOUS/NOT_FOUND), `confidence`
        (rapidfuzz's real 0-100 score; None only for NOT_FOUND), and
        either a resolved supplierId/supplierName (MATCHED) or a
        `candidates` list of the top 2-3 scored options (AMBIGUOUS).

    Raises:
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    client = get_backend_client()
    suppliers = await client.get("/suppliers")
    candidates = [{"id": supplier["id"], "name": supplier["name"]} for supplier in suppliers]

    classification = _classify_fuzzy_match(supplier_name, candidates)

    result = {
        "documentId": document_id,
        "extractedSupplierName": supplier_name,
        "status": classification["status"],
        "supplierId": classification["id"],
        "supplierName": classification["name"],
        "confidence": classification["confidence"],
        "candidates": [
            {"supplierId": entry["id"], "supplierName": entry["name"], "score": entry["score"]}
            for entry in classification["candidates"]
        ],
    }
    return FindSupplierResponse.model_validate(result).model_dump(mode="json")


def _sum_extracted_items_value(items: list[dict]) -> Optional[float]:
    """Sum quantity * unitPrice across extracted line items that HAVE a
    price - items without one are excluded, not treated as free (same
    convention as _sum_po_items_value below, and the backend's own
    calculateTransactionCost()). Returns None only when NOT A SINGLE item
    has a price - there is nothing real to sum, so returning 0.0 would
    misrepresent "unknown" as "free of charge."

    Operates on the already-reshaped {"productNameRaw","quantity","unitPrice"}
    shape from _map_extracted_items(), not the raw backend
    {"product","quantity","price"} shape - unitPrice here is a plain JSON
    number (PendingDocumentReview.extractedItems is a Json blob populated
    with ordinary numbers, not a Prisma Decimal), so no float()/string
    conversion is needed, unlike _sum_po_items_value below.
    """
    priced = [item for item in items if item["unitPrice"] is not None]
    if not priced:
        return None
    return sum(item["quantity"] * item["unitPrice"] for item in priced)


def _sum_po_items_value(items: list[dict]) -> float:
    """Sum quantity * price across a real InventoryTransaction's items.

    Duplicated locally from agents/insights_agent/tools.py's
    _sum_transaction_value (same ~10-line pattern) - deliberately NOT
    cross-imported, each agent's tools.py stays self-contained (see the
    wiring investigation). price arrives from the backend as a Prisma
    Decimal, serialized over HTTP as a JSON STRING - must be explicitly
    float()-converted, never assumed numeric already.

    In practice every INCOMING transaction item is guaranteed to have a
    price (createIncoming() requires it - see
    inventory-transactions.service.ts's requirePrice), so the "exclude
    unpriced" branch below is defensive, not load-bearing, on the PO side
    specifically - unlike _sum_extracted_items_value above, where a
    missing price is a real, expected case.
    """
    total = 0.0
    for item in items:
        price = item.get("price")
        if price is None:
            continue
        total += item["quantity"] * float(price)
    return total


@tool
async def match_invoice_to_po(document_id: str, supplier_id: int) -> dict:
    """Try to match this invoice against an existing open purchase order for the same supplier. INVOICE BRANCH ONLY.

    Do not call this for an "order" doc_type.

    Real logic (2026-08-22, see the wiring investigation): fetches the
    document (GET /document-review/:id, same call extract_document makes)
    and sums quantity * unitPrice across its extractedItems that have a
    price - this is the extracted total. If NOT A SINGLE item has a price,
    there is nothing real to compare, so this returns INSUFFICIENT_DATA
    immediately rather than guessing. Otherwise fetches that supplier's
    open POs (GET /inventory-transactions?type=INCOMING&status=PENDING&
    supplierId=X - items included inline, confirmed cheap: real seed data
    has at most one PENDING INCOMING PO per supplier), computes each PO's
    real total (every INCOMING item is guaranteed priced at creation, so
    this is always a complete total), and compares against the extracted
    total within a tolerance of 2% of the larger amount or $1.00,
    whichever is greater (_po_amount_tolerance - a REASONED DEFAULT, not
    empirically calibrated: real seed data only has two PENDING INCOMING
    POs total, not enough diversity to derive a threshold from evidence
    the way rapidfuzz's thresholds were).

    Args:
        document_id: The invoice document to match - the real numeric
            PendingDocumentReview id (as a string), same as
            extract_document()'s document_id. An unrecognized id 404s for
            real, same as extract_document().
        supplier_id: The matched supplier's database ID (from find_supplier()).

    Returns:
        A dict with `status` (MATCHED/NO_MATCH/MULTIPLE_CANDIDATES/
        INSUFFICIENT_DATA), `extractedTotal`/`purchaseOrderTotal`/
        `amountDifference` (real numbers - no invented "confidence" score,
        a total-amount comparison isn't a probabilistic match), and either
        a resolved `purchaseOrderId` (MATCHED) or a `candidates` list of
        the top real POs within tolerance (MULTIPLE_CANDIDATES).

    Raises:
        ValueError: If document_id isn't a valid integer id.
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if a backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    try:
        numeric_id = int(document_id)
    except ValueError as exc:
        raise ValueError(
            f"document_id must be a real numeric PendingDocumentReview id, got {document_id!r}"
        ) from exc

    client = get_backend_client()
    review = await client.get(f"/document-review/{numeric_id}")
    extracted_items = _map_extracted_items(review["extractedItems"])
    extracted_total = _sum_extracted_items_value(extracted_items)

    if extracted_total is None:
        return MatchInvoiceToPoResponse.model_validate(
            {
                "documentId": document_id,
                "status": "INSUFFICIENT_DATA",
                "purchaseOrderId": None,
                "extractedTotal": None,
                "purchaseOrderTotal": None,
                "amountDifference": None,
                "candidates": [],
            }
        ).model_dump(mode="json")

    transactions = await client.get(
        "/inventory-transactions",
        params={"type": "INCOMING", "status": "PENDING", "supplierId": supplier_id},
    )

    scored = []
    for transaction in transactions:
        total = _sum_po_items_value(transaction["items"])
        scored.append(
            {
                "purchaseOrderId": transaction["id"],
                "total": total,
                "expectedDate": transaction["expectedDate"],
                "difference": extracted_total - total,
            }
        )
    scored.sort(key=lambda entry: abs(entry["difference"]))

    within_tolerance = [
        entry for entry in scored if abs(entry["difference"]) <= _po_amount_tolerance(extracted_total, entry["total"])
    ]

    if not within_tolerance:
        result = {
            "documentId": document_id,
            "status": "NO_MATCH",
            "purchaseOrderId": None,
            "extractedTotal": extracted_total,
            "purchaseOrderTotal": None,
            "amountDifference": None,
            "candidates": [],
        }
    elif len(within_tolerance) == 1:
        best = within_tolerance[0]
        result = {
            "documentId": document_id,
            "status": "MATCHED",
            "purchaseOrderId": best["purchaseOrderId"],
            "extractedTotal": extracted_total,
            "purchaseOrderTotal": best["total"],
            "amountDifference": best["difference"],
            "candidates": [],
        }
    else:
        result = {
            "documentId": document_id,
            "status": "MULTIPLE_CANDIDATES",
            "purchaseOrderId": None,
            "extractedTotal": extracted_total,
            "purchaseOrderTotal": None,
            "amountDifference": None,
            "candidates": [
                {"purchaseOrderId": entry["purchaseOrderId"], "total": entry["total"], "expectedDate": entry["expectedDate"]}
                for entry in within_tolerance[:3]
            ],
        }

    return MatchInvoiceToPoResponse.model_validate(result).model_dump(mode="json")


_WAREHOUSE_ELIGIBLE_PATH = "/warehouse-routing/eligible-warehouses"


def _merge_order_items(extracted_items: list[dict], classifications: list[dict]) -> tuple[list[dict], list[str]]:
    """Resolves extracted line items to real productIds via the shared
    classification helper (_match_names_to_catalog), merging duplicate
    productIds by SUMMING their quantities - two raw line items that
    happen to resolve to the same real product must be checked as one
    combined quantity requirement, not two independent ones. The real
    eligible-warehouses endpoint has no dedup logic of its own (see
    warehouse-routing.service.ts) - two separate entries for the same
    productId would each be checked against the SAME onHand/reserved
    figures independently, silently under-counting the true combined
    requirement.

    Returns (resolved_items, unresolved_raw_names): resolved_items is
    [{"productId": int, "quantity": int}, ...], one entry per DISTINCT
    resolved productId, in first-seen order. unresolved_raw_names is
    every extracted item's raw productNameRaw whose classification wasn't
    MATCHED (AMBIGUOUS or NOT_FOUND) - never silently dropped, always
    reported back (see ChooseFulfillmentWarehouseResponse.unresolvedItems).
    """
    quantity_by_product_id: dict[int, int] = {}
    unresolved: list[str] = []

    for extracted_item, classification in zip(extracted_items, classifications):
        if classification["status"] != "MATCHED":
            unresolved.append(extracted_item["productNameRaw"])
            continue
        product_id = classification["id"]
        quantity_by_product_id[product_id] = quantity_by_product_id.get(product_id, 0) + extracted_item["quantity"]

    resolved_items = [{"productId": pid, "quantity": qty} for pid, qty in quantity_by_product_id.items()]
    return resolved_items, unresolved


def _min_remaining_margin(items: list[dict]) -> int:
    """The smallest (available - requestedQuantity) across a warehouse's
    real order-line-item availability rows (EligibleWarehouseItemAvailability
    shape) - how much stock headroom this warehouse has on its TIGHTEST
    item, not an average. Always >= 0 for a genuinely eligible warehouse
    (eligibility itself requires available >= requestedQuantity for every
    item).
    """
    return min(item["available"] - item["requestedQuantity"] for item in items)


def _select_fulfillment_warehouse(eligible_warehouses: list[dict]) -> dict:
    """Pure selection logic - no I/O. Given every stock-eligible warehouse
    for the FULL order (from POST /warehouse-routing/eligible-warehouses),
    picks the real recommendation.

    No geography/distance is considered here - this project does not
    integrate any mapping/geocoding provider, so ranking is purely stock-
    based:
      1. Every eligible warehouse becomes a candidate, enriched with its
         real minRemainingMargin.
      2. The largest minRemainingMargin wins - the warehouse safest on its
         tightest line item, not just highest on average.
      3. Any tie (equal margin) is broken by warehouseId ascending, for
         determinism.

    eligible_warehouses: [{"warehouseId": int, "warehouseName": str,
    "items": [{"available": int, "requestedQuantity": int}, ...]}, ...] -
    the "items" shape matches the real EligibleWarehouseItemAvailability.

    Returns {"winner_id": int | None, "reason": str, "candidates": [...]}.
    winner_id is None only when eligible_warehouses is empty - callers
    handle NO_ELIGIBLE_WAREHOUSE before ever reaching this function, but
    it degrades safely if called with an empty list regardless.
    """
    if not eligible_warehouses:
        return {"winner_id": None, "reason": "No stock-eligible warehouse.", "candidates": []}

    candidates = [
        {
            "warehouseId": warehouse["warehouseId"],
            "warehouseName": warehouse["warehouseName"],
            "minRemainingMargin": _min_remaining_margin(warehouse["items"]),
        }
        for warehouse in eligible_warehouses
    ]

    ranked = sorted(candidates, key=lambda c: (-c["minRemainingMargin"], c["warehouseId"]))
    winner = ranked[0]
    reason = (
        f"{winner['warehouseName']} is stock-eligible with the largest stock margin on its "
        f"tightest line item ({winner['minRemainingMargin']} units)."
    )

    return {"winner_id": winner["warehouseId"], "reason": reason, "candidates": candidates}


@tool
async def choose_fulfillment_warehouse(document_id: str) -> dict:
    """Choose which warehouse should fulfill this order. ORDER BRANCH ONLY.

    Do not call this for an "invoice" doc_type.

    Real logic (2026-08-22, see the wiring investigation): fetches the
    document (GET /document-review/:id, same call extract_document makes)
    for its extractedItems and extractedDeliveryCountry/
    extractedDeliveryRegion, resolves each raw product name to a real
    productId itself via the SAME shared classification helper
    match_products()/detect_discrepancy() use (_match_names_to_catalog) -
    never trusts productIds relayed through the calling agent's own
    conversation. Items that resolve to the same real product are merged
    (quantities summed) - see _merge_order_items.

    STEP 1 (the real correctness filter): POST /warehouse-routing/
    eligible-warehouses with every resolved line item - returns ONLY
    warehouses that can fully stock the ENTIRE order at the requested
    quantities, never a partial match. If this comes back empty, status
    is NO_ELIGIBLE_WAREHOUSE - a real, honest answer, not a silent
    fallback to whichever warehouse happens to have the most stock.

    STEP 2 (selection - see _select_fulfillment_warehouse for the pure
    logic): no geography/distance is considered - this project does not
    integrate any mapping/geocoding provider. Among the step-1-eligible
    warehouses, the one with the largest MINIMUM remaining margin
    (available - requested) across every order line item wins, i.e. the
    warehouse safest on its tightest item, not just highest on average.
    Ties are broken by warehouseId for determinism.

    Args:
        document_id: The order document being fulfilled - the real
            numeric PendingDocumentReview id (as a string), same as
            extract_document()'s document_id. An unrecognized id 404s for
            real, same as extract_document().

    Returns:
        A dict with `status` (RECOMMENDED/NO_ELIGIBLE_WAREHOUSE/
        INSUFFICIENT_DATA), `recommendedWarehouseId`/`Name` (set only for
        RECOMMENDED), a deterministic `reason`, `unresolvedItems` (raw
        names that couldn't be matched to a real product - any
        recommendation is INCOMPLETE if this is non-empty), and
        `candidates` (every stock-eligible warehouse considered, with
        real minRemainingMargin).

    Raises:
        ValueError: If document_id isn't a valid integer id.
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if the document fetch
        or the eligible-warehouses call fails. Deliberately NOT caught/
        swallowed here - same pattern as every other wired tool in this
        file.
    """
    try:
        numeric_id = int(document_id)
    except ValueError as exc:
        raise ValueError(
            f"document_id must be a real numeric PendingDocumentReview id, got {document_id!r}"
        ) from exc

    client = get_backend_client()
    review = await client.get(f"/document-review/{numeric_id}")
    extracted_items = _map_extracted_items(review["extractedItems"])
    classifications = await _match_names_to_catalog(client, [item["productNameRaw"] for item in extracted_items])
    resolved_items, unresolved_items = _merge_order_items(extracted_items, classifications)

    if not resolved_items:
        return ChooseFulfillmentWarehouseResponse.model_validate(
            {
                "documentId": document_id,
                "status": "INSUFFICIENT_DATA",
                "recommendedWarehouseId": None,
                "recommendedWarehouseName": None,
                "reason": "None of this order's extracted line items could be matched to a real product.",
                "unresolvedItems": unresolved_items,
                "candidates": [],
            }
        ).model_dump(mode="json")

    eligible = await client.post(
        _WAREHOUSE_ELIGIBLE_PATH,
        json={
            "deliveryCountry": review.get("extractedDeliveryCountry"),
            "deliveryRegion": review.get("extractedDeliveryRegion"),
            "items": resolved_items,
        },
    )

    if not eligible:
        return ChooseFulfillmentWarehouseResponse.model_validate(
            {
                "documentId": document_id,
                "status": "NO_ELIGIBLE_WAREHOUSE",
                "recommendedWarehouseId": None,
                "recommendedWarehouseName": None,
                "reason": "No warehouse can fully stock every line item of this order at the requested quantities.",
                "unresolvedItems": unresolved_items,
                "candidates": [],
            }
        ).model_dump(mode="json")

    selection = _select_fulfillment_warehouse(eligible)
    winner = next(c for c in selection["candidates"] if c["warehouseId"] == selection["winner_id"])

    return ChooseFulfillmentWarehouseResponse.model_validate(
        {
            "documentId": document_id,
            "status": "RECOMMENDED",
            "recommendedWarehouseId": winner["warehouseId"],
            "recommendedWarehouseName": winner["warehouseName"],
            "reason": selection["reason"],
            "unresolvedItems": unresolved_items,
            "candidates": selection["candidates"],
        }
    ).model_dump(mode="json")


# Duplicate-detection thresholds - REASONED DEFAULTS, not empirically
# calibrated (same caveat as _PO_TOLERANCE_PERCENT/_WAREHOUSE_TIE_DISTANCE_KM
# above): real seed data has only one currently-PENDING document at a
# time, nowhere near enough real duplicate/non-duplicate pairs to derive
# these from evidence the way rapidfuzz's thresholds were. Flagged
# explicitly as judgment calls in the wiring investigation.
_DUPLICATE_DATE_WINDOW_DAYS = 3
_DUPLICATE_ITEM_OVERLAP_THRESHOLD = 0.5
_DUPLICATE_SIGNAL_THRESHOLD = 3


def _identity_name(review: dict) -> Optional[str]:
    """extractedSupplierName for an INCOMING (invoice) document,
    extractedPartyName for an OUTGOING (order) one - which field carries
    "who this document is about" depends on transactionType.
    """
    if review["transactionType"] == "INCOMING":
        return review.get("extractedSupplierName")
    return review.get("extractedPartyName")


def _normalize_identity_name(name: Optional[str]) -> Optional[str]:
    if name is None:
        return None
    normalized = name.strip().lower()
    return normalized or None


def _dates_within_window(a: Optional[str], b: Optional[str]) -> bool:
    """True only when BOTH sides have a real extractedDate and they fall
    within _DUPLICATE_DATE_WINDOW_DAYS of each other - a missing date on
    either side means this signal simply doesn't count as agreeing, never
    defaulted to a match.
    """
    if a is None or b is None:
        return False
    return abs(datetime.fromisoformat(a) - datetime.fromisoformat(b)) <= timedelta(days=_DUPLICATE_DATE_WINDOW_DAYS)


def _totals_close(a: Optional[float], b: Optional[float]) -> bool:
    """Same tolerance as match_invoice_to_po's PO-total comparison
    (_po_amount_tolerance) - reused, not reimplemented. False when either
    side has no real total to compare, never defaulted to a match.
    """
    if a is None or b is None:
        return False
    return abs(a - b) <= _po_amount_tolerance(a, b)


def _jaccard_ratio(a: set[int], b: set[int]) -> Optional[float]:
    """Real Jaccard similarity (|intersection| / |union|) of two resolved
    productId sets - a well-defined number, not a fabricated score. None
    only when there is nothing real to compare (both sides empty), never
    fabricated as 0.
    """
    union = a | b
    if not union:
        return None
    return len(a & b) / len(union)


def _duplicate_signals(*, same_identity: bool, dates_close: bool, totals_close: bool, items_overlap: bool) -> list[str]:
    """Returns which of the 4 real signals agreed, in a fixed order - this
    IS matchedOn's exact contents. Pure, no I/O. The >= 3-of-4 threshold
    itself is applied by the caller (len(signals) >= _DUPLICATE_SIGNAL_THRESHOLD).
    """
    signals = []
    if same_identity:
        signals.append("supplier")
    if dates_close:
        signals.append("date")
    if totals_close:
        signals.append("total")
    if items_overlap:
        signals.append("items")
    return signals


@tool
async def detect_duplicate_document(document_id: str) -> dict:
    """Find similar currently-pending reviews for human duplicate assessment.

    This cannot establish exact document identity: the backend exposes no
    document hash, stable invoice number, or list-all review-history
    endpoint. It compares extracted content only and is scoped to rows from
    GET /document-review/pending. A positive result is therefore a
    POTENTIAL duplicate for human review, never proof and never an automatic
    reason to reject or block the document.

    Real logic (2026-08-22, see the wiring investigation): fetches the
    target document (GET /document-review/:id, same call extract_document
    makes) and the full candidate pool (GET /document-review/pending -
    ALL currently-pending reviews, unfiltered; the endpoint has no
    server-side narrowing), excludes the target itself, then keeps only
    candidates with the SAME transactionType (an invoice and an order are
    never a duplicate pair regardless of anything else matching).

    For each remaining candidate, evaluates 4 real signals: supplier/party
    identity (extractedSupplierName for an invoice, extractedPartyName for
    an order - normalized, exact match), date proximity (extractedDate
    within 3 days - only counts if both sides have one), total value
    proximity (reuses match_invoice_to_po's exact tolerance - 2% of the
    larger total, or $1.00, whichever is greater), and item overlap (both
    sides' raw item names resolved to real productIds via the SAME shared
    _match_names_to_catalog() helper match_products()/detect_discrepancy()
    use, then compared as a real Jaccard ratio - >= 0.5 counts as
    agreeing). A candidate is flagged as a likely duplicate when >= 3 of
    these 4 signals agree - a majority-of-4 rule, a REASONED DEFAULT like
    the tolerance/window constants above, not empirically calibrated (real
    seed data has never had two simultaneously-pending documents to
    validate against).

    Every candidate's item list (plus the target's own) is resolved
    against the real catalog in ONE combined _match_names_to_catalog()
    call, not one call per candidate - GET /products is fetched exactly
    once regardless of how many pending candidates exist.

    Args:
        document_id: The document to check - the real numeric
            PendingDocumentReview id (as a string), same as
            extract_document()'s document_id. An unrecognized id 404s for
            real, same as extract_document().

    Returns:
        A dict with advisory `status`, `isPotentialDuplicate`, explicit
        `scope`/`evidenceLimitations`, and a `matches` list (possibly empty) -
        each entry has `documentReviewId`, `matchedOn` (which real signals
        agreed), the candidate's own real `extractedIdentityName`/
        `extractedDate`/`totalValue` for direct human comparison, and a
        real `itemOverlapRatio` - no invented similarity score. Sorted by
        most signals agreed first.

    Raises:
        ValueError: If document_id isn't a valid integer id.
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if a backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    try:
        numeric_id = int(document_id)
    except ValueError as exc:
        raise ValueError(
            f"document_id must be a real numeric PendingDocumentReview id, got {document_id!r}"
        ) from exc

    client = get_backend_client()
    target = await client.get(f"/document-review/{numeric_id}")
    pending = await client.get("/document-review/pending")

    candidates = [
        review for review in pending if review["id"] != numeric_id and review["transactionType"] == target["transactionType"]
    ]

    if not candidates:
        return DetectDuplicateDocumentResponse.model_validate(
            {
                "documentId": document_id,
                "status": "NO_SIMILAR_PENDING_REVIEW",
                "isPotentialDuplicate": False,
                "scope": "PENDING_REVIEWS_ONLY",
                "evidenceLimitations": (
                    "No exact file hash or stable invoice identifier is available, and processed "
                    "APPROVED/REJECTED review history is not enumerable through the backend API."
                ),
                "matches": [],
            }
        ).model_dump(mode="json")

    target_items = _map_extracted_items(target["extractedItems"])
    target_identity = _normalize_identity_name(_identity_name(target))
    target_total = _sum_extracted_items_value(target_items)

    candidate_items_by_id = {review["id"]: _map_extracted_items(review["extractedItems"]) for review in candidates}

    # One combined catalog resolution for the target plus every candidate -
    # GET /products is fetched exactly once (inside _match_names_to_catalog),
    # never once per candidate.
    all_raw_names: list[str] = [item["productNameRaw"] for item in target_items]
    boundaries: dict[Optional[int], tuple[int, int]] = {None: (0, len(all_raw_names))}
    for review in candidates:
        start = len(all_raw_names)
        all_raw_names.extend(item["productNameRaw"] for item in candidate_items_by_id[review["id"]])
        boundaries[review["id"]] = (start, len(all_raw_names))

    all_classifications = await _match_names_to_catalog(client, all_raw_names) if all_raw_names else []

    def _resolved_ids(key: Optional[int]) -> set[int]:
        start, end = boundaries[key]
        return {entry["id"] for entry in all_classifications[start:end] if entry["status"] == "MATCHED"}

    target_item_ids = _resolved_ids(None)

    matches = []
    for review in candidates:
        candidate_identity = _normalize_identity_name(_identity_name(review))
        candidate_total = _sum_extracted_items_value(candidate_items_by_id[review["id"]])
        overlap_ratio = _jaccard_ratio(target_item_ids, _resolved_ids(review["id"]))

        signals = _duplicate_signals(
            same_identity=target_identity is not None and target_identity == candidate_identity,
            dates_close=_dates_within_window(target.get("extractedDate"), review.get("extractedDate")),
            totals_close=_totals_close(target_total, candidate_total),
            items_overlap=overlap_ratio is not None and overlap_ratio >= _DUPLICATE_ITEM_OVERLAP_THRESHOLD,
        )

        if len(signals) >= _DUPLICATE_SIGNAL_THRESHOLD:
            matches.append(
                {
                    "documentReviewId": review["id"],
                    "matchedOn": signals,
                    "extractedIdentityName": _identity_name(review),
                    "extractedDate": review.get("extractedDate"),
                    "totalValue": candidate_total,
                    "itemOverlapRatio": overlap_ratio,
                }
            )

    matches.sort(key=lambda match: len(match["matchedOn"]), reverse=True)

    return DetectDuplicateDocumentResponse.model_validate(
        {
            "documentId": document_id,
            "status": (
                "POTENTIAL_DUPLICATE_REVIEW"
                if matches
                else "NO_SIMILAR_PENDING_REVIEW"
            ),
            "isPotentialDuplicate": bool(matches),
            "scope": "PENDING_REVIEWS_ONLY",
            "evidenceLimitations": (
                "Similarity is based on extracted identity/date/value/items, not exact file "
                "identity. Only currently pending reviews can be enumerated."
            ),
            "matches": matches,
        }
    ).model_dump(mode="json")


@tool
async def detect_discrepancy(document_id: str, po_id: int, supplier_id: int) -> dict:
    """Compare THIS DOCUMENT'S DATA (quantities, prices, line items) against the purchase order it should match. INVOICE BRANCH ONLY.

    Do not call this for an "order" doc_type - a "purchase order" only
    exists for INCOMING (invoice) transactions, so there is nothing for an
    order document to be compared against.

    This is about content mismatches, not document identity: it answers
    "does this document's data match what we expected", never "have we
    already processed this exact document" - that second question is
    detect_duplicate_document()'s job, not this tool's.

    Real logic (2026-08-22, see the wiring investigation): fetches the
    document's extractedItems (GET /document-review/:id) and resolves each
    raw product name to a real productId itself, via the SAME fetch+
    classify logic match_products() uses (_match_names_to_catalog) - this
    tool never trusts productIds relayed through the calling agent's own
    conversation, since a raw extracted name is not the same thing as a
    resolved real productId, and re-deriving it here is the only way to
    guarantee the diff below compares real products, not text. Fetches the
    real PO (GET /inventory-transactions/:id) for its real items[]
    (productId/quantity/price) and its own supplierId - the latter is
    independently compared against the supplier_id passed in (not assumed
    consistent just because match_invoice_to_po might have found this PO
    via a supplier-scoped search) and flagged as SUPPLIER_MISMATCH if they
    differ. PRICE_MISMATCH reuses match_invoice_to_po's exact tolerance
    (_po_amount_tolerance), applied per line rather than to a total.

    Args:
        document_id: The invoice document to check - the real numeric
            PendingDocumentReview id (as a string), same as
            extract_document()'s document_id. An unrecognized id 404s for
            real, same as extract_document().
        po_id: The purchase order (INCOMING InventoryTransaction) id to
            compare against - from match_invoice_to_po()'s real
            purchaseOrderId when status is MATCHED. Never a guessed or
            reused po_id.
        supplier_id: The invoice's own matched supplier ID (from
            find_supplier()) - compared against the PO's real supplierId
            as an independent check, not assumed to already match.

    Returns:
        A dict with `hasDiscrepancies` and a `discrepancies` list - each
        entry has a `type` (QUANTITY_MISMATCH/PRICE_MISMATCH/
        MISSING_LINE_ITEM/UNEXPECTED_LINE_ITEM/SUPPLIER_MISMATCH), real
        expected/actual values, and a deterministic `severity` (never left
        to the model - MISSING_LINE_ITEM/UNEXPECTED_LINE_ITEM/
        SUPPLIER_MISMATCH are HIGH, QUANTITY_MISMATCH is MEDIUM,
        PRICE_MISMATCH is LOW normally or MEDIUM when the gap exceeds 2x
        tolerance).

    Raises:
        ValueError: If document_id isn't a valid integer id.
        Unauthorized, Forbidden, NotFound, ValidationError, Conflict, or
        ServiceUnavailable (see backend_client.py) if a backend call
        fails. Deliberately NOT caught/swallowed here - same pattern as
        every other wired tool in this file.
    """
    try:
        numeric_document_id = int(document_id)
    except ValueError as exc:
        raise ValueError(
            f"document_id must be a real numeric PendingDocumentReview id, got {document_id!r}"
        ) from exc

    client = get_backend_client()
    review = await client.get(f"/document-review/{numeric_document_id}")
    po = await client.get(f"/inventory-transactions/{po_id}")

    extracted_items = _map_extracted_items(review["extractedItems"])
    classifications = await _match_names_to_catalog(client, [item["productNameRaw"] for item in extracted_items])

    discrepancies: list[dict] = []

    if po["supplierId"] != supplier_id:
        discrepancies.append(
            {
                "type": "SUPPLIER_MISMATCH",
                "productId": None,
                "productName": None,
                "expectedValue": str(supplier_id),
                "actualValue": str(po["supplierId"]),
                "severity": "HIGH",
            }
        )

    po_items_by_product_id = {item["productId"]: item for item in po["items"]}
    matched_product_ids: set[int] = set()

    for extracted_item, classification in zip(extracted_items, classifications):
        if classification["status"] != "MATCHED":
            discrepancies.append(
                {
                    "type": "UNEXPECTED_LINE_ITEM",
                    "productId": None,
                    "productName": extracted_item["productNameRaw"],
                    "expectedValue": None,
                    "actualValue": f"could not be resolved to a real product (status: {classification['status']})",
                    "severity": "HIGH",
                }
            )
            continue

        product_id = classification["id"]
        po_item = po_items_by_product_id.get(product_id)
        if po_item is None:
            discrepancies.append(
                {
                    "type": "UNEXPECTED_LINE_ITEM",
                    "productId": product_id,
                    "productName": classification["name"],
                    "expectedValue": None,
                    "actualValue": f"quantity {extracted_item['quantity']}",
                    "severity": "HIGH",
                }
            )
            continue

        matched_product_ids.add(product_id)

        if extracted_item["quantity"] != po_item["quantity"]:
            discrepancies.append(
                {
                    "type": "QUANTITY_MISMATCH",
                    "productId": product_id,
                    "productName": classification["name"],
                    "expectedValue": str(po_item["quantity"]),
                    "actualValue": str(extracted_item["quantity"]),
                    "severity": "MEDIUM",
                }
            )

        extracted_price = extracted_item["unitPrice"]
        po_price = float(po_item["price"]) if po_item.get("price") is not None else None
        if extracted_price is not None and po_price is not None:
            tolerance = _po_amount_tolerance(extracted_price, po_price)
            diff = abs(extracted_price - po_price)
            if diff > tolerance:
                discrepancies.append(
                    {
                        "type": "PRICE_MISMATCH",
                        "productId": product_id,
                        "productName": classification["name"],
                        "expectedValue": str(po_price),
                        "actualValue": str(extracted_price),
                        "severity": "MEDIUM" if diff > 2 * tolerance else "LOW",
                    }
                )

    for product_id, po_item in po_items_by_product_id.items():
        if product_id not in matched_product_ids:
            discrepancies.append(
                {
                    "type": "MISSING_LINE_ITEM",
                    "productId": product_id,
                    "productName": None,
                    "expectedValue": f"quantity {po_item['quantity']}",
                    "actualValue": None,
                    "severity": "HIGH",
                }
            )

    result = {
        "documentId": document_id,
        "hasDiscrepancies": len(discrepancies) > 0,
        "discrepancies": discrepancies,
        "comparedAgainst": f"purchaseOrderId={po_id}",
    }
    return DetectDiscrepancyResponse.model_validate(result).model_dump(mode="json")
