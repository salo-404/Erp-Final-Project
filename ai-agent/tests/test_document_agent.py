"""Smoke tests for the Document agent - both the invoice and order branches.

ALL SEVEN document_agent tools are wired to the real backend now
(2026-08-22, detect_duplicate_document was the last one):
extract_document(), match_products(), find_supplier(), match_invoice_to_po(),
detect_discrepancy(), choose_fulfillment_warehouse(), and
detect_duplicate_document() (GET /document-review/:id,
GET /document-review/pending, GET /products, GET /suppliers,
GET /inventory-transactions, POST /warehouse-routing/eligible-warehouses,
POST /path-optimizer/nearest-warehouse - see backend_client.py).
tools/mocks/document_mock_data.py (every tool's old mocked implementation)
was deleted entirely as dead code once its last real caller here was
wired. Every wired tool's own tests use httpx.MockTransport (see
_patch_backend_client below), same pattern as tests/test_insights_agent.py.
match_products()/find_supplier() carry pure-logic tests for
_classify_fuzzy_match() (the rapidfuzz classification core) and
live-backend regression tests, including the real "Office" ambiguous tie
confirmed in the wiring investigation. match_invoice_to_po()/
detect_discrepancy() carry pure-logic tests for their tolerance/summation
helpers, wired tests covering every status/discrepancy type (MULTIPLE_
CANDIDATES is mock-only - real seed data has no supplier with 2+ open POs),
and live-backend regression tests using entirely real, unmodified seed data
(a genuine NO_MATCH and a genuine discrepancy diff - see the tests'
docstrings for why a live MATCHED case needs new seed data this task
doesn't add). _match_names_to_catalog() - the fetch+classify helper shared
by match_products(), detect_discrepancy(), choose_fulfillment_warehouse(),
and detect_duplicate_document() - has its own test confirming it produces
identical classifications to match_products()'s own output.
choose_fulfillment_warehouse() carries pure-logic tests for its
selection/tiebreak math (a clear distance winner, a real 50km tie needing
the stock-margin tiebreak, and a null-distance fallback - all
mock/pure-logic-only, since real live geocoding never succeeds in this dev
environment, see below), wired tests for every status, and a live-backend
regression test that IS achievable with real, unmodified seed data despite
that geocoding limitation. detect_duplicate_document() carries pure-logic
tests for each of its 4 real signals (supplier/party identity, date
window, total tolerance - reused from match_invoice_to_po, Jaccard item
overlap) plus the >= 3-of-4 decision rule, wired tests for a genuine
duplicate-found case and correct exclusion of non-matching/different-type
candidates, and a live-backend regression test for the real "no duplicate"
path - a genuine "duplicate found" live scenario isn't achievable with
current seed data (only one document is ever PENDING at a time) and stays
mock/pure-logic-verified only, same category of limitation as
match_invoice_to_po's MULTIPLE_CANDIDATES and the 50km tie.

Two additional tests actually call a real model (test_document_agent_live_openai_smoke
via the OpenAI provider specifically, test_document_agent_reports_tool_error_instead_of_fabricating
via whichever provider is configured) - see tests/_helpers.py for the skip
conditions. Both are deliberately phrased so the model already has the
"extracted" data inline in the prompt rather than being invited to call
extract_document() with a fictional document_id - extract_document()
requires a real numeric id and a real backend, which would make these two
mock-only, backend-independent tests either fail for the wrong reason or
need to gate on backend_reachable(), neither of which matches their actual
purpose (verifying the model integration and the no-fabrication behavior,
not the full pipeline). Both patch GET /products via httpx.MockTransport,
since match_products() is real too - and, as of every tool being wired
now, if the model happens to also call detect_duplicate_document() with
the fictional document_id these prompts mention, it 404s for real and the
agent is expected to report that honestly rather than fabricate a result,
exactly like every other wired tool.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import time

import httpx
import pytest

from agents.document_agent import tools as document_tools_module
from agents.document_agent.agent import DOCUMENT_TOOLS, _extract_matched_data, build_document_agent
from agents.document_agent.prompts import DOCUMENT_SYSTEM_PROMPT
from agents.document_agent.tools import (
    DocumentReviewAuthorizationRequired,
    _NEAREST_WAREHOUSE_PATH,
    _WAREHOUSE_ELIGIBLE_PATH,
    _classify_fuzzy_match,
    _dates_within_window,
    _duplicate_signals,
    _identity_name,
    _jaccard_ratio,
    _map_extracted_items,
    _match_names_to_catalog,
    _merge_order_items,
    _min_remaining_margin,
    _normalize_identity_name,
    _po_amount_tolerance,
    _select_fulfillment_warehouse,
    _sum_extracted_items_value,
    _sum_po_items_value,
    _totals_close,
    approve_document_review,
    choose_fulfillment_warehouse,
    detect_discrepancy,
    detect_duplicate_document,
    extract_document,
    find_supplier,
    get_document_review,
    get_pending_document_reviews,
    match_invoice_to_po,
    match_products,
    reject_document_review,
    resolve_document_product,
    resolve_document_supplier,
)
from backend_client import (
    BackendClient,
    Forbidden,
    HumanAuthenticatedBackendClient,
    NotFound,
    ServiceUnavailable,
    Unauthorized,
    get_backend_client,
)
from config.settings import settings
from request_context import human_auth_scope
from tests._helpers import backend_reachable, live_model_configured

UNKNOWN_DOCUMENT_ID = "doc_totally_made_up_id"
# Placeholder text for the two live-model tests' prompts only - these two
# tests give the model already-extracted data inline and never actually
# call a tool with this string, so any fictional-looking id works; this
# used to be tools/mocks/document_mock_data.py's KNOWN_INVOICE_DOCUMENT_ID
# constant, now inlined directly since that file (100% dead - all 7
# document_agent tools are wired) was deleted.
_INVOICE_PROMPT_PLACEHOLDER_DOCUMENT_ID = "doc_inv_2026_0815_001"

# Real, confirmed product/supplier catalog from the rapidfuzz wiring
# investigation (ids 73-80 / 41-43) - shaped exactly like the real bare-array
# GET /products / GET /suppliers responses (see products.service.ts /
# suppliers.service.ts), reused across the pure-logic, wired, and live tests
# below so the fixture data and the real evidence stay in one place.
_REAL_PRODUCT_ROWS = [
    {"id": 73, "name": "Laptop Pro 14", "category": None, "description": None, "isActive": True},
    {"id": 74, "name": "Wireless Mouse", "category": None, "description": None, "isActive": True},
    {"id": 75, "name": "Mechanical Keyboard", "category": None, "description": None, "isActive": True},
    {"id": 76, "name": "27-inch Monitor", "category": None, "description": None, "isActive": True},
    {"id": 77, "name": "USB-C Dock", "category": None, "description": None, "isActive": True},
    {"id": 78, "name": "Office Headset", "category": None, "description": None, "isActive": True},
    {"id": 79, "name": "HD Webcam", "category": None, "description": None, "isActive": True},
    {"id": 80, "name": "Office Chair", "category": None, "description": None, "isActive": True},
]
_REAL_SUPPLIER_ROWS = [
    {
        "id": 41,
        "name": "TechSource Lebanon",
        "email": None,
        "leadTimeDays": None,
        "isActive": True,
        "createdAt": "2026-01-01T00:00:00.000Z",
    },
    {
        "id": 42,
        "name": "Cedar Electronics",
        "email": None,
        "leadTimeDays": None,
        "isActive": True,
        "createdAt": "2026-01-01T00:00:00.000Z",
    },
    {
        "id": 43,
        "name": "Levant Trading",
        "email": None,
        "leadTimeDays": None,
        "isActive": True,
        "createdAt": "2026-01-01T00:00:00.000Z",
    },
]
_PRODUCT_CANDIDATES = [{"id": row["id"], "name": row["name"]} for row in _REAL_PRODUCT_ROWS]
_SUPPLIER_CANDIDATES = [{"id": row["id"], "name": row["name"]} for row in _REAL_SUPPLIER_ROWS]


def _fake_jwt() -> str:
    """Minimal, correctly-shaped (unsigned) JWT - see test_backend_client.py's
    identical helper for why the signature doesn't matter here."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": 1, "email": "ai-agent@internal.local", "role": "EMPLOYEE", "exp": time.time() + 3600}).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.fake-signature"


def _patch_backend_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """Point extract_document() at a BackendClient backed by
    httpx.MockTransport instead of the real network - same pattern as
    tests/test_insights_agent.py. Patches the name as bound inside
    agents.document_agent.tools (where `from backend_client import
    get_backend_client` already resolved it at import time), not the
    origin backend_client module.
    """
    test_client = BackendClient(
        base_url="http://backend.test",
        email="ai-agent@internal.local",
        password="irrelevant-mocked",
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(document_tools_module, "get_backend_client", lambda: test_client)


def test_document_agent_builds_standalone() -> None:
    """The Document agent must construct without any Supervisor dependency."""
    agent = build_document_agent()
    assert agent.name == "document_agent"
    assert len(DOCUMENT_TOOLS) == 7


def test_document_runtime_registry_is_exact() -> None:
    assert DOCUMENT_TOOLS == [
        get_pending_document_reviews,
        get_document_review,
        resolve_document_product,
        resolve_document_supplier,
        approve_document_review,
        reject_document_review,
        detect_duplicate_document,
    ]
    for inactive_tool in (
        extract_document,
        match_products,
        find_supplier,
        match_invoice_to_po,
        detect_discrepancy,
        choose_fulfillment_warehouse,
    ):
        assert inactive_tool not in DOCUMENT_TOOLS


def test_document_runtime_has_no_mock_dependency() -> None:
    assert "tools.mocks" not in inspect.getsource(document_tools_module)


def test_document_prompt_locks_current_ownership_and_safety() -> None:
    prompt = " ".join(DOCUMENT_SYSTEM_PROMPT.split())
    assert "Raw file extraction happens before you are called" in prompt
    assert "is not one of your tools" in prompt
    assert "Never mutate inventory directly" in prompt
    assert "Never invent or guess" in prompt
    assert "authenticated human ADMIN" in prompt
    assert "Never claim a decision occurred unless the backend tool explicitly confirms it" in prompt
    assert "Do not invent or refer to a separate PurchaseOrder model" in prompt


def test_structured_handoff_preserves_exact_resolved_ids_and_quantities() -> None:
    messages = [
        {"content": [
            {"toolUse": {"toolUseId": "r1", "name": "resolve_document_product", "input": {
                "document_id": "501", "product_name": "27in Monitor", "requested_quantity": 12,
            }}},
            {"toolUse": {"toolUseId": "r2", "name": "resolve_document_product", "input": {
                "document_id": "501", "product_name": "Mechanical Keyboard", "requested_quantity": 25,
            }}},
        ]},
        {"content": [
            {"toolResult": {"toolUseId": "r1", "content": [{"text": json.dumps({
                "documentId": "501", "productNameRaw": "27in Monitor",
                "requestedQuantity": 12, "status": "RESOLVED", "productId": 103,
            })}]}},
            {"toolResult": {"toolUseId": "r2", "content": [{"text": json.dumps({
                "documentId": "501", "productNameRaw": "Mechanical Keyboard",
                "requestedQuantity": 25, "status": "RESOLVED", "productId": 108,
            })}]}},
        ]},
    ]

    assert _extract_matched_data(messages) == {
        "document_id": "501",
        "product_ids": [103, 108],
        "requested_quantities": [
            {"product_id": 103, "quantity": 12},
            {"product_id": 108, "quantity": 25},
        ],
    }


def test_review_decisions_fail_closed_without_admin_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    constructed = {"count": 0}

    def forbidden_constructor(*args, **kwargs):
        constructed["count"] += 1
        raise AssertionError("human backend client must not be constructed")

    monkeypatch.setattr(
        document_tools_module,
        "HumanAuthenticatedBackendClient",
        forbidden_constructor,
    )
    with pytest.raises(DocumentReviewAuthorizationRequired, match="no approval occurred"):
        asyncio.run(approve_document_review(document_id="501", items=[{"productId": 103, "quantity": 1}]))
    with pytest.raises(DocumentReviewAuthorizationRequired, match="no rejection occurred"):
        asyncio.run(reject_document_review(document_id="501", rejection_reason="Duplicate"))
    assert constructed["count"] == 0


def _patch_human_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    monkeypatch.setattr(
        document_tools_module,
        "HumanAuthenticatedBackendClient",
        lambda token: HumanAuthenticatedBackendClient(
            token,
            base_url="http://backend.test",
            transport=httpx.MockTransport(handler),
        ),
    )


def test_review_decisions_use_human_bearer_token_and_real_endpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(
            (request.url.path, request.headers["Authorization"], json.loads(request.content))
        )
        if request.url.path == "/document-review/501/approve":
            return httpx.Response(200, json={"id": 501, "status": "APPROVED"})
        if request.url.path == "/document-review/502/reject":
            return httpx.Response(200, json={"id": 502, "status": "REJECTED"})
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_human_client(monkeypatch, handler)
    with human_auth_scope("human-admin-jwt"):
        approved = asyncio.run(
            approve_document_review(
                document_id="501",
                items=[{"productId": 103, "quantity": 2}],
                supplier_id=41,
                destination_warehouse_id=2,
            )
        )
        rejected = asyncio.run(
            reject_document_review(document_id="502", rejection_reason="Duplicate")
        )

    assert approved["status"] == "APPROVED"
    assert rejected["status"] == "REJECTED"
    assert requests == [
        (
            "/document-review/501/approve",
            "Bearer human-admin-jwt",
            {
                "items": [{"productId": 103, "quantity": 2}],
                "supplierId": 41,
                "destinationWarehouseId": 2,
            },
        ),
        (
            "/document-review/502/reject",
            "Bearer human-admin-jwt",
            {"rejectionReason": "Duplicate"},
        ),
    ]


@pytest.mark.parametrize(
    ("status", "error_type"),
    [(401, Unauthorized), (403, Forbidden)],
)
def test_review_authorization_failures_propagate_without_fake_success(
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    error_type: type[Exception],
) -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(status, json={"message": "not authorized"})

    _patch_human_client(monkeypatch, handler)
    with human_auth_scope("invalid-or-employee-jwt"):
        with pytest.raises(error_type):
            asyncio.run(
                approve_document_review(
                    document_id="501",
                    items=[{"productId": 103, "quantity": 1}],
                )
            )
    assert calls["count"] == 1


def test_human_auth_is_request_isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    authorizations: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        authorizations.append(request.headers["Authorization"])
        return httpx.Response(200, json={"ok": True})

    _patch_human_client(monkeypatch, handler)
    for token, review_id in (("request-a", "501"), ("request-b", "502")):
        with human_auth_scope(token):
            asyncio.run(reject_document_review(review_id, "Duplicate"))
    with pytest.raises(DocumentReviewAuthorizationRequired):
        asyncio.run(reject_document_review("503", "Duplicate"))

    assert authorizations == ["Bearer request-a", "Bearer request-b"]


def test_human_jwt_is_not_llm_visible() -> None:
    for review_tool in (approve_document_review, reject_document_review):
        parameters = inspect.signature(review_tool).parameters
        assert not any("token" in name.lower() or "jwt" in name.lower() for name in parameters)
    assert "JWT" not in DOCUMENT_SYSTEM_PROMPT
    assert "bearer" not in DOCUMENT_SYSTEM_PROMPT.lower()


def test_core_read_tools_use_authoritative_document_review_endpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append((request.url.path, request.url.params.get("query", "")))
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        assert request.headers["Authorization"] != "Bearer human-admin-jwt"
        if request.url.path == "/document-review/pending":
            return httpx.Response(200, json=[{"id": 501, "status": "PENDING_REVIEW"}])
        if request.url.path == "/document-review/501":
            return httpx.Response(200, json={"id": 501, "status": "PENDING_REVIEW", "extractedItems": []})
        if request.url.path == "/document-review/resolve-product":
            return httpx.Response(200, json=[{"productId": 103, "name": "27in Monitor", "score": 1}])
        if request.url.path == "/document-review/resolve-supplier":
            return httpx.Response(200, json=[{"supplierId": 41, "name": "TechSource", "score": 1}])
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    with human_auth_scope("human-admin-jwt"):
        assert asyncio.run(get_pending_document_reviews())["reviews"][0]["id"] == 501
        assert asyncio.run(get_document_review(document_id="501"))["id"] == 501
        product = asyncio.run(resolve_document_product("501", "27in Monitor", 12))
        supplier = asyncio.run(resolve_document_supplier("501", "TechSource"))

    assert product["status"] == "RESOLVED" and product["productId"] == 103
    assert product["requestedQuantity"] == 12
    assert supplier["status"] == "RESOLVED" and supplier["supplierId"] == 41
    assert ("/document-review/resolve-product", "27in Monitor") in requested
    assert ("/document-review/resolve-supplier", "TechSource") in requested


@pytest.mark.parametrize(
    ("resolver", "resolver_path", "resolver_args"),
    [
        (
            resolve_document_product,
            "/document-review/resolve-product",
            ("999", "27in Monitor", 12),
        ),
        (
            resolve_document_supplier,
            "/document-review/resolve-supplier",
            ("999", "TechSource"),
        ),
    ],
)
def test_document_resolvers_stop_when_numeric_review_does_not_exist(
    monkeypatch: pytest.MonkeyPatch,
    resolver,
    resolver_path: str,
    resolver_args: tuple,
) -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/999":
            return httpx.Response(404, json={"message": "Review not found"})
        raise AssertionError(f"resolver must not be called after 404: {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(NotFound, match="Review not found"):
        asyncio.run(resolver(*resolver_args))

    assert "/document-review/999" in requested_paths
    assert resolver_path not in requested_paths


def test_map_extracted_items_handles_missing_price() -> None:
    """Pure logic: price is optional in the real extractedItems Json blob -
    an entry with no `price` key at all maps to unitPrice: None, never
    fabricated as 0.
    """
    raw_items = [
        {"product": "Laptop Pro 14", "quantity": 5, "price": 820},
        {"product": "Wireless Mouse", "quantity": 3},
    ]
    mapped = _map_extracted_items(raw_items)
    assert mapped[0] == {"productNameRaw": "Laptop Pro 14", "quantity": 5, "unitPrice": 820}
    assert mapped[1] == {"productNameRaw": "Wireless Mouse", "quantity": 3, "unitPrice": None}


def test_extract_document_rejects_non_numeric_document_id() -> None:
    """No network call is ever attempted - the int() conversion fails first,
    before get_backend_client() is even called."""
    with pytest.raises(ValueError):
        asyncio.run(extract_document(document_id=UNKNOWN_DOCUMENT_ID))


def test_extract_document_invoice_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real
    GET /document-review/:id (a bare PendingDocumentReview object -
    confirmed against document-review.service.ts/schema.prisma).
    transactionType INCOMING - proves the id->documentId string
    conversion, the INCOMING->"invoice" docType derivation, and full
    field pass-through (including both real delivery-address-family
    fields and status/rejectionReason, which had no AI-schema slot
    before this tool was wired) against a realistic payload.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/501":
            return httpx.Response(
                200,
                json={
                    "id": 501,
                    "documentUrl": "https://example-bucket.s3.amazonaws.com/documents/sample-invoice.pdf",
                    "documentKey": "documents/sample-invoice.pdf",
                    "transactionType": "INCOMING",
                    "extractedPartyName": None,
                    "extractedSupplierName": "TechSource Lebanon",
                    "extractedDate": "2026-08-15T09:00:00.000Z",
                    "extractedWarehouseName": "Beirut Warehouse",
                    "extractedDeliveryCountry": None,
                    "extractedDeliveryRegion": None,
                    "extractedDeliveryAddress": None,
                    "extractedItems": [
                        {"product": "Laptop Pro 14", "quantity": 5, "price": 820},
                        {"product": "Wireless Mouse", "quantity": 10, "price": 17},
                    ],
                    "status": "PENDING_REVIEW",
                    "rejectionReason": None,
                    "reviewedById": None,
                    "reviewedAt": None,
                    "transactionId": None,
                    "createdAt": "2026-08-15T09:00:00.000Z",
                    "updatedAt": "2026-08-15T09:00:00.000Z",
                },
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(extract_document(document_id="501"))

    assert result["documentId"] == "501"
    assert result["docType"] == "invoice"  # INCOMING -> invoice, no guessing
    assert result["status"] == "PENDING_REVIEW"
    assert result["extractedSupplierName"] == "TechSource Lebanon"
    assert result["extractedPartyName"] is None
    assert result["extractedWarehouseName"] == "Beirut Warehouse"
    assert result["rejectionReason"] is None
    assert len(result["extractedItems"]) == 2
    assert result["extractedItems"][0] == {"productNameRaw": "Laptop Pro 14", "quantity": 5, "unitPrice": 820.0}
    assert result["extractedItems"][1] == {"productNameRaw": "Wireless Mouse", "quantity": 10, "unitPrice": 17.0}


def test_extract_document_order_wired_handles_missing_price_line_item(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """transactionType OUTGOING - proves OUTGOING->"order" docType
    derivation, and the missing-price line-item case specifically: one
    entry has no `price` key at all (a real, valid shape for the
    extractedItems Json blob), which must map to unitPrice: None, never
    a fabricated 0. Also proves extractedDeliveryAddress (a real field
    with no AI-schema slot before this tool was wired) passes through,
    and status APPROVED / a real rejectionReason: None on an approved row.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/777":
            return httpx.Response(
                200,
                json={
                    "id": 777,
                    "documentUrl": "https://example-bucket.s3.amazonaws.com/documents/approved-invoice.pdf",
                    "documentKey": None,
                    "transactionType": "OUTGOING",
                    "extractedPartyName": "Example Customer",
                    "extractedSupplierName": None,
                    "extractedDate": None,
                    "extractedWarehouseName": "Beirut Warehouse",
                    "extractedDeliveryCountry": "Lebanon",
                    "extractedDeliveryRegion": "Beirut",
                    "extractedDeliveryAddress": "123 Hamra Street",
                    "extractedItems": [
                        {"product": "Wireless Mouse", "quantity": 3},
                    ],
                    "status": "APPROVED",
                    "rejectionReason": None,
                    "reviewedById": 1,
                    "reviewedAt": "2026-08-16T09:00:00.000Z",
                    "transactionId": 55,
                    "createdAt": "2026-08-15T09:00:00.000Z",
                    "updatedAt": "2026-08-16T09:00:00.000Z",
                },
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(extract_document(document_id="777"))

    assert result["documentId"] == "777"
    assert result["docType"] == "order"  # OUTGOING -> order, no guessing
    assert result["status"] == "APPROVED"
    assert result["extractedPartyName"] == "Example Customer"
    assert result["extractedDeliveryAddress"] == "123 Hamra Street"
    assert result["rejectionReason"] is None
    assert len(result["extractedItems"]) == 1
    assert result["extractedItems"][0] == {"productNameRaw": "Wireless Mouse", "quantity": 3, "unitPrice": None}


def test_extract_document_propagates_not_found_for_unknown_id(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(404, json={"message": "PendingDocumentReview 999999 not found"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(NotFound):
        asyncio.run(extract_document(document_id="999999"))


def test_extract_document_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(503, json={"message": "document review service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(extract_document(document_id="1"))


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_extract_document_live_against_real_backend() -> None:
    """FETCH PATH ONLY - does not exercise the real upload->extraction
    pipeline (POST /document-review/upload). That requires
    RIBAL_AGENT_URL, which is unconfigured in local dev (backend/.env has
    it set to a placeholder, "unused-local-dev") - genuinely out of scope
    for this tool per the task, which only fetches an already-extracted
    row via GET /document-review/:id.

    Instead, this discovers a real id via GET /document-review/pending
    (rather than hardcoding one) and fetches it through extract_document()
    - backend/prisma/seed.ts's "PENDING DOCUMENT REVIEW" section seeds
    exactly one PENDING_REVIEW row (an INCOMING/invoice document from
    TechSource Lebanon) alongside one APPROVED row not returned by
    /pending, so a real PENDING_REVIEW document is expected to exist in
    any freshly-seeded dev database.
    """

    async def _fetch_via_a_real_pending_document() -> tuple[str, dict]:
        client = get_backend_client()
        pending = await client.get("/document-review/pending")
        assert pending, "Expected at least one real PENDING_REVIEW document in seed data"
        document_id = str(pending[0]["id"])
        result = await extract_document(document_id=document_id)
        return document_id, result

    document_id, result = asyncio.run(_fetch_via_a_real_pending_document())

    assert result["documentId"] == document_id
    assert result["docType"] in {"invoice", "order"}
    assert result["status"] == "PENDING_REVIEW"
    assert isinstance(result["extractedItems"], list)
    assert len(result["extractedItems"]) > 0
    for item in result["extractedItems"]:
        assert {"productNameRaw", "quantity", "unitPrice"} <= item.keys()


# ---------------------------------------------------------------------------
# ALL SEVEN document_agent tools are wired to the real backend now
# (2026-08-22, detect_duplicate_document was the last one) - a
# document-specific tool must refuse to fabricate a result for a
# document_id that was never actually provided. This used to be enforced
# by DocumentNotFoundError against a small fictional mock document set;
# every tool now enforces it for real instead (a genuine 404/ValueError
# against the real backend) - see each tool's own
# rejects_non_numeric_document_id/propagates_not_found_for_unknown_document
# tests further below.
# ---------------------------------------------------------------------------


def _patch_catalog_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """Backend double serving both GET /products and GET /suppliers from the
    real, confirmed catalog fixtures above - shared by every wired
    match_products()/find_supplier() test that doesn't need to assert on
    the request itself.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/suppliers":
            return httpx.Response(200, json=_REAL_SUPPLIER_ROWS)
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)


_PO_901 = {
    "id": 901,
    "supplierId": 41,
    "sourceWarehouseId": None,
    "destinationWarehouseId": 1,
    "type": "INCOMING",
    "status": "PENDING",
    "expectedDate": "2026-09-01T00:00:00.000Z",
    "items": [
        {"id": 1, "productId": 73, "quantity": 5, "price": "820.00"},
        {"id": 2, "productId": 74, "quantity": 10, "price": "17.00"},
    ],
}


def test_invoice_branch_downstream_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    """match_products -> find_supplier -> match_invoice_to_po ->
    detect_discrepancy, ALL real now (2026-08-22 - see the wiring
    investigation for match_invoice_to_po()/detect_discrepancy()).

    Unlike the old version of this test, match_invoice_to_po() and
    detect_discrepancy() now fetch the real document themselves (same
    /document-review/:id call extract_document() makes), so the old
    fictional string document_id ("doc_inv_2026_0815_001", from the now-
    deleted tools/mocks/document_mock_data.py) no longer works for this
    chain at all - a real numeric document_id ("601") is used throughout,
    with a mocked /document-review/601 response standing in for the real
    backend.

    Deliberately constructed so every step lands on a clean, positive
    result (MATCHED with amountDifference 0.0, zero discrepancies) - a
    "happy path" proving the full real chain threads correctly end to
    end; each individual discrepancy type and each match_invoice_to_po
    status has its own dedicated test further below.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/suppliers":
            return httpx.Response(200, json=_REAL_SUPPLIER_ROWS)
        if request.url.path == "/document-review/601":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [
                        {"product": "Laptop Pro 14", "quantity": 5, "price": 820},
                        {"product": "Wireless Optical Mouse", "quantity": 10, "price": 17},
                    ],
                },
            )
        if request.url.path == "/inventory-transactions":
            assert request.url.params.get("supplierId") == "41"
            return httpx.Response(200, json=[_PO_901])
        if request.url.path == "/inventory-transactions/901":
            return httpx.Response(200, json=_PO_901)
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    product_names = ["Laptop Pro 14", "Wireless Optical Mouse"]

    matched = asyncio.run(match_products(document_id="601", product_names=product_names))
    assert len(matched["matches"]) == len(product_names)
    assert all(m["status"] == "MATCHED" for m in matched["matches"])

    supplier = asyncio.run(find_supplier(document_id="601", supplier_name="TechSouce Lebanon"))
    assert supplier["status"] == "MATCHED"
    assert supplier["supplierId"] == 41

    po_match = asyncio.run(match_invoice_to_po(document_id="601", supplier_id=supplier["supplierId"]))
    assert po_match["status"] == "MATCHED"
    assert po_match["purchaseOrderId"] == 901
    assert po_match["extractedTotal"] == 4270.0
    assert po_match["purchaseOrderTotal"] == 4270.0
    assert po_match["amountDifference"] == 0.0

    discrepancy = asyncio.run(
        detect_discrepancy(document_id="601", po_id=po_match["purchaseOrderId"], supplier_id=supplier["supplierId"])
    )
    assert discrepancy["hasDiscrepancies"] is False
    assert discrepancy["discrepancies"] == []
    assert discrepancy["comparedAgainst"] == "purchaseOrderId=901"


def test_order_branch_downstream_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    """match_products -> choose_fulfillment_warehouse, both real now
    (choose_fulfillment_warehouse wired 2026-08-22 - see the wiring
    investigation). Unlike the old version of this test,
    choose_fulfillment_warehouse() now fetches the real document itself
    (same /document-review/:id call extract_document() makes) rather than
    taking product_ids/delivery_region as caller-supplied arguments, so
    the old fictional string document_id ("doc_ord_2026_0815_001", from
    the now-deleted tools/mocks/document_mock_data.py) no longer works
    for it at all - a real numeric document_id ("801") is used
    throughout, with a mocked /document-review/801 response standing in
    for the real backend.

    No find_customer() step - that tool was removed (no Customer model
    exists anywhere in the real backend; there was never a real capability
    behind it).

    Deliberately constructed with a CLEAR (non-tied) distance winner - the
    50km-tie tiebreak has its own dedicated test further below.
    """
    eligible_response = [
        {
            "warehouseId": 1,
            "warehouseName": "London Central",
            "location": "London, United Kingdom",
            "items": [
                {"productId": 76, "onHand": 100, "reserved": 10, "available": 90, "requestedQuantity": 5},
                {"productId": 75, "onHand": 50, "reserved": 5, "available": 45, "requestedQuantity": 3},
            ],
        },
        {
            "warehouseId": 2,
            "warehouseName": "Manchester North",
            "location": "Manchester, United Kingdom",
            "items": [
                {"productId": 76, "onHand": 60, "reserved": 5, "available": 55, "requestedQuantity": 5},
                {"productId": 75, "onHand": 40, "reserved": 5, "available": 35, "requestedQuantity": 3},
            ],
        },
    ]
    nearest_response = {
        "consideredCandidates": [
            {"warehouseId": 1, "warehouseName": "London Central", "location": "London, United Kingdom", "available": 90, "distanceKm": 300.0},
            {"warehouseId": 2, "warehouseName": "Manchester North", "location": "Manchester, United Kingdom", "available": 55, "distanceKm": 50.0},
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/document-review/801":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [
                        {"product": "27in Monitor", "quantity": 5, "price": 189},
                        {"product": "Mechanical Keyboard", "quantity": 3, "price": 55},
                    ],
                    "extractedDeliveryCountry": "United Kingdom",
                    "extractedDeliveryRegion": "Greater Manchester",
                },
            )
        if request.url.path == _WAREHOUSE_ELIGIBLE_PATH:
            body = json.loads(request.content)
            assert {item["productId"] for item in body["items"]} == {76, 75}
            return httpx.Response(200, json=eligible_response)
        if request.url.path == _NEAREST_WAREHOUSE_PATH:
            body = json.loads(request.content)
            assert body["productId"] == 76
            assert body["requiredQuantity"] == 5
            return httpx.Response(200, json=nearest_response)
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    matched = asyncio.run(match_products(document_id="801", product_names=["27in Monitor", "Mechanical Keyboard"]))
    assert all(m["status"] == "MATCHED" for m in matched["matches"])

    warehouse = asyncio.run(choose_fulfillment_warehouse(document_id="801"))
    assert warehouse["status"] == "RECOMMENDED"
    assert warehouse["recommendedWarehouseId"] == 2
    assert warehouse["recommendedWarehouseName"] == "Manchester North"
    assert warehouse["unresolvedItems"] == []
    assert len(warehouse["candidates"]) == 2
    winner_candidate = next(c for c in warehouse["candidates"] if c["warehouseId"] == 2)
    assert winner_candidate["distanceKm"] == 50.0
    assert winner_candidate["distanceUnconfirmed"] is False
    assert winner_candidate["minRemainingMargin"] == 32


# ---------------------------------------------------------------------------
# _classify_fuzzy_match: pure-logic tests against the rapidfuzz classifier
# itself, no backend/network involved. Covers exactly the scenarios the
# wiring investigation validated against real data: a clear match, the real
# "Office" ambiguous tie, a score in the ambiguous band, a score below
# NOT_FOUND, and the known "Mouse Pad" false-positive limitation (accepted,
# not a bug - see tools.py::_classify_fuzzy_match's docstring and
# prompts.py rule 6).
# ---------------------------------------------------------------------------


def test_classify_fuzzy_match_clear_match() -> None:
    result = _classify_fuzzy_match("Laptop Pro 14", _PRODUCT_CANDIDATES)
    assert result["status"] == "MATCHED"
    assert result["id"] == 73
    assert result["name"] == "Laptop Pro 14"
    assert result["confidence"] == 100.0
    assert result["candidates"] == []


def test_classify_fuzzy_match_real_office_tie_is_ambiguous() -> None:
    """Real, confirmed evidence from the wiring investigation: raw text
    "Office" scores 90.0 against BOTH "Office Headset" and "Office Chair"
    in the real catalog - an exact tie between two genuinely plausible
    products, not a bug in the classifier. Locked in as a permanent
    regression test.
    """
    result = _classify_fuzzy_match("Office", _PRODUCT_CANDIDATES)
    assert result["status"] == "AMBIGUOUS"
    assert result["id"] is None
    assert result["confidence"] == 90.0
    candidate_ids = {c["id"] for c in result["candidates"]}
    assert {78, 80} <= candidate_ids  # Office Headset, Office Chair


def test_classify_fuzzy_match_ambiguous_band() -> None:
    """A single plausible-but-not-confident candidate: top score lands in
    [60, 80) with no close runner-up needed to be AMBIGUOUS.
    """
    result = _classify_fuzzy_match("Office Desk", _PRODUCT_CANDIDATES)
    assert result["status"] == "AMBIGUOUS"
    assert result["confidence"] is not None
    assert 60 <= result["confidence"] < 80


def test_classify_fuzzy_match_not_found() -> None:
    result = _classify_fuzzy_match("Bluetooth Speaker", _PRODUCT_CANDIDATES)
    assert result["status"] == "NOT_FOUND"
    assert result["id"] is None
    assert result["name"] is None
    assert result["confidence"] is None
    assert result["candidates"] == []


def test_classify_fuzzy_match_known_false_positive_limitation() -> None:
    """KNOWN, ACCEPTED LIMITATION - not a bug to fix here (see
    _classify_fuzzy_match's docstring and prompts.py rule 6): "Mouse Pad"
    scores high enough to MATCH "Wireless Mouse" despite being a different,
    nonexistent product (confirmed in the wiring investigation, score
    85.5). Locked in so a future rapidfuzz upgrade or threshold change
    doesn't silently alter this known behavior without review.
    """
    result = _classify_fuzzy_match("Mouse Pad", _PRODUCT_CANDIDATES)
    assert result["status"] == "MATCHED"
    assert result["name"] == "Wireless Mouse"


def test_classify_fuzzy_match_empty_candidates_is_not_found() -> None:
    result = _classify_fuzzy_match("Anything", [])
    assert result["status"] == "NOT_FOUND"
    assert result["candidates"] == []


# ---------------------------------------------------------------------------
# _po_amount_tolerance/_sum_extracted_items_value/_sum_po_items_value: pure-
# logic tests for match_invoice_to_po()/detect_discrepancy()'s tolerance
# math and total-summation helpers - no backend/network involved. The
# tolerance itself (2% of the larger amount, or $1.00, whichever is
# greater) is a REASONED DEFAULT, not empirically calibrated the way
# rapidfuzz's thresholds were - see the wiring investigation.
# ---------------------------------------------------------------------------


def test_po_amount_tolerance_uses_percentage_above_the_floor() -> None:
    # 2% of 5000 = 100, well above the $1 floor.
    assert _po_amount_tolerance(5000.0, 5000.0) == 100.0
    assert _po_amount_tolerance(4270.0, 4270.0) == pytest.approx(85.4)


def test_po_amount_tolerance_uses_floor_below_the_percentage_threshold() -> None:
    # 2% of 20 = 0.40, below the $1 floor - the floor wins.
    assert _po_amount_tolerance(20.0, 18.0) == 1.0


def test_po_amount_tolerance_uses_the_larger_of_the_two_amounts() -> None:
    assert _po_amount_tolerance(100.0, 5000.0) == _po_amount_tolerance(5000.0, 100.0) == 100.0


def test_sum_extracted_items_value_excludes_unpriced_items() -> None:
    items = [
        {"productNameRaw": "Laptop Pro 14", "quantity": 5, "unitPrice": 820.0},
        {"productNameRaw": "Wireless Mouse", "quantity": 10, "unitPrice": None},
    ]
    assert _sum_extracted_items_value(items) == 4100.0


def test_sum_extracted_items_value_is_none_when_nothing_is_priced() -> None:
    items = [{"productNameRaw": "Laptop Pro 14", "quantity": 5, "unitPrice": None}]
    assert _sum_extracted_items_value(items) is None


def test_sum_po_items_value_converts_decimal_as_string_price() -> None:
    """Real PO items serialize price as a JSON STRING (Prisma Decimal via
    decimal.js), not a number - must be float()-converted, never assumed
    numeric already (same gotcha as insights_agent's _sum_transaction_value).
    """
    items = [
        {"productId": 73, "quantity": 5, "price": "820.00"},
        {"productId": 74, "quantity": 10, "price": "17.00"},
    ]
    assert _sum_po_items_value(items) == 4270.0


def test_sum_po_items_value_excludes_unpriced_items_defensively() -> None:
    """Defensive, not load-bearing in practice - every INCOMING item is
    guaranteed a price at creation - but the helper must never silently
    treat a missing price as free (0) if that invariant is ever violated.
    """
    items = [{"productId": 73, "quantity": 5, "price": None}]
    assert _sum_po_items_value(items) == 0.0


# ---------------------------------------------------------------------------
# match_products()/find_supplier(): wired-path tests against a mocked
# backend (httpx.MockTransport, real catalog shape) - proves the HTTP fetch
# + classification integration, not just the pure classifier above.
# ---------------------------------------------------------------------------


def test_match_products_wired_end_to_end_against_mocked_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_catalog_backend(monkeypatch)

    result = asyncio.run(
        match_products(
            document_id="31",
            product_names=["Laptop Pro 14", "Office", "Bluetooth Speaker"],
        )
    )

    by_raw = {m["productNameRaw"]: m for m in result["matches"]}

    assert by_raw["Laptop Pro 14"]["status"] == "MATCHED"
    assert by_raw["Laptop Pro 14"]["productId"] == 73
    assert by_raw["Laptop Pro 14"]["confidence"] == 100.0
    assert by_raw["Laptop Pro 14"]["candidates"] == []

    assert by_raw["Office"]["status"] == "AMBIGUOUS"
    assert by_raw["Office"]["productId"] is None
    candidate_names = {c["productName"] for c in by_raw["Office"]["candidates"]}
    assert {"Office Headset", "Office Chair"} <= candidate_names

    assert by_raw["Bluetooth Speaker"]["status"] == "NOT_FOUND"
    assert by_raw["Bluetooth Speaker"]["confidence"] is None
    assert by_raw["Bluetooth Speaker"]["candidates"] == []


def test_match_names_to_catalog_matches_match_products_behavior_exactly(monkeypatch: pytest.MonkeyPatch) -> None:
    """Confirms the shared internal helper _match_names_to_catalog() -
    factored out of match_products()'s own fetch+classify logic so
    detect_discrepancy() can reuse it - produces IDENTICAL classifications
    to calling match_products() directly, for the exact same inputs. Calls
    _match_names_to_catalog() directly against a mocked BackendClient
    (bypassing the @tool wrapper entirely, since it's a plain internal
    function, not a tool) and compares its raw classification output
    against match_products()'s own per-item fields for the same names.
    """
    _patch_catalog_backend(monkeypatch)
    raw_names = ["Laptop Pro 14", "Office", "Bluetooth Speaker"]

    test_client = BackendClient(
        base_url="http://backend.test",
        email="ai-agent@internal.local",
        password="irrelevant-mocked",
        transport=httpx.MockTransport(
            lambda request: (
                httpx.Response(200, json={"access_token": _fake_jwt()})
                if request.url.path == "/auth/login"
                else httpx.Response(200, json=_REAL_PRODUCT_ROWS)
            )
        ),
    )
    classifications = asyncio.run(_match_names_to_catalog(test_client, raw_names))

    via_match_products = asyncio.run(match_products(document_id="31", product_names=raw_names))
    by_raw = {m["productNameRaw"]: m for m in via_match_products["matches"]}

    for raw_name, classification in zip(raw_names, classifications):
        match = by_raw[raw_name]
        assert classification["status"] == match["status"]
        assert classification["id"] == match["productId"]
        assert classification["name"] == match["productName"]
        assert classification["confidence"] == match["confidence"]
        assert [c["id"] for c in classification["candidates"]] == [c["productId"] for c in match["candidates"]]


def test_find_supplier_wired_end_to_end_against_mocked_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_catalog_backend(monkeypatch)

    matched = asyncio.run(find_supplier(document_id="31", supplier_name="TechSouce Lebanon"))
    assert matched["status"] == "MATCHED"
    assert matched["supplierId"] == 41
    assert matched["supplierName"] == "TechSource Lebanon"
    assert matched["candidates"] == []

    not_found = asyncio.run(find_supplier(document_id="31", supplier_name="Nordic Components AB"))
    assert not_found["status"] == "NOT_FOUND"
    assert not_found["supplierId"] is None
    assert not_found["confidence"] is None


def test_match_products_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(503, json={"message": "product catalog service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(match_products(document_id="31", product_names=["Laptop Pro 14"]))


def test_find_supplier_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(503, json={"message": "supplier catalog service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(find_supplier(document_id="31", supplier_name="TechSource Lebanon"))


# ---------------------------------------------------------------------------
# match_invoice_to_po(): wired-path tests against a mocked backend
# (httpx.MockTransport). MULTIPLE_CANDIDATES is mock-only, deliberately -
# real seed data has at most one PENDING INCOMING PO per supplier (no
# supplier has ever had two), so this status is LOGIC-VERIFIED here, not
# live-data-verified - see the wiring investigation. MATCHED is covered by
# test_invoice_branch_downstream_chain above (the full real chain).
# ---------------------------------------------------------------------------


def _document_review_handler(document_id: str, extracted_items: list[dict]):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == f"/document-review/{document_id}":
            return httpx.Response(200, json={"extractedItems": extracted_items})
        raise AssertionError(f"unexpected path {request.url.path}")

    return handler


def test_match_invoice_to_po_no_match_when_supplier_has_no_open_pos(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/701":
            return httpx.Response(
                200, json={"extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}]}
            )
        if request.url.path == "/inventory-transactions":
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(match_invoice_to_po(document_id="701", supplier_id=42))
    assert result["status"] == "NO_MATCH"
    assert result["purchaseOrderId"] is None
    assert result["extractedTotal"] == 4100.0
    assert result["purchaseOrderTotal"] is None
    assert result["candidates"] == []


def test_match_invoice_to_po_no_match_when_totals_diverge(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/702":
            return httpx.Response(
                200, json={"extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}]}
            )
        if request.url.path == "/inventory-transactions":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 902,
                        "supplierId": 41,
                        "expectedDate": "2026-09-05T00:00:00.000Z",
                        "items": [{"productId": 73, "quantity": 30, "price": "825.00"}],
                    }
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    # Extracted total 4100 vs PO total 24750 - the real seeded values from
    # the wiring investigation - miles outside the ~$495 tolerance.
    result = asyncio.run(match_invoice_to_po(document_id="702", supplier_id=41))
    assert result["status"] == "NO_MATCH"
    assert result["extractedTotal"] == 4100.0
    assert result["purchaseOrderTotal"] is None


def test_match_invoice_to_po_multiple_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    """MOCK-ONLY - real seed data has no supplier with 2+ open POs (see
    module docstring above), so this scenario is synthetic: two POs from
    the same supplier both land within tolerance of the extracted total.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/703":
            return httpx.Response(
                200, json={"extractedItems": [{"product": "Laptop Pro 14", "quantity": 10, "price": 1000}]}
            )
        if request.url.path == "/inventory-transactions":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 903,
                        "supplierId": 41,
                        "expectedDate": "2026-09-10T00:00:00.000Z",
                        "items": [{"productId": 73, "quantity": 10, "price": "1005.00"}],
                    },
                    {
                        "id": 904,
                        "supplierId": 41,
                        "expectedDate": "2026-09-12T00:00:00.000Z",
                        "items": [{"productId": 73, "quantity": 10, "price": "998.00"}],
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    # Extracted total 10000. PO 903 total 10050 (diff 50, tolerance 201) and
    # PO 904 total 9980 (diff 20, tolerance ~199.6) both land within
    # tolerance - two genuinely plausible candidates.
    result = asyncio.run(match_invoice_to_po(document_id="703", supplier_id=41))
    assert result["status"] == "MULTIPLE_CANDIDATES"
    assert result["purchaseOrderId"] is None
    candidate_ids = [c["purchaseOrderId"] for c in result["candidates"]]
    assert set(candidate_ids) == {903, 904}
    # Sorted by closeness to the extracted total - PO 904 (diff 20) first.
    assert candidate_ids[0] == 904


def test_match_invoice_to_po_insufficient_data_when_nothing_is_priced(monkeypatch: pytest.MonkeyPatch) -> None:
    """No extracted item has a price - INSUFFICIENT_DATA is returned
    immediately, WITHOUT ever calling /inventory-transactions (the handler
    below has no branch for it, so an unexpected call there would fail the
    test with an AssertionError, not silently pass).
    """
    handler = _document_review_handler(
        "704", [{"product": "Laptop Pro 14", "quantity": 5}, {"product": "Wireless Mouse", "quantity": 10}]
    )
    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(match_invoice_to_po(document_id="704", supplier_id=41))
    assert result["status"] == "INSUFFICIENT_DATA"
    assert result["purchaseOrderId"] is None
    assert result["extractedTotal"] is None
    assert result["purchaseOrderTotal"] is None
    assert result["candidates"] == []


def test_match_invoice_to_po_rejects_non_numeric_document_id() -> None:
    with pytest.raises(ValueError):
        asyncio.run(match_invoice_to_po(document_id=UNKNOWN_DOCUMENT_ID, supplier_id=41))


def test_match_invoice_to_po_propagates_not_found_for_unknown_document(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(404, json={"message": "PendingDocumentReview 999999 not found"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(NotFound):
        asyncio.run(match_invoice_to_po(document_id="999999", supplier_id=41))


def test_match_invoice_to_po_propagates_typed_backend_error_from_po_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/705":
            return httpx.Response(
                200, json={"extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}]}
            )
        return httpx.Response(503, json={"message": "inventory transactions service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(match_invoice_to_po(document_id="705", supplier_id=41))


# ---------------------------------------------------------------------------
# detect_discrepancy(): wired-path tests against a mocked backend. The
# "clean, everything matches" case is covered by
# test_invoice_branch_downstream_chain above. This section covers each
# discrepancy type - QUANTITY_MISMATCH, PRICE_MISMATCH (LOW and MEDIUM),
# MISSING_LINE_ITEM, and both UNEXPECTED_LINE_ITEM sub-cases (resolved to a
# real product not on the PO, and unresolved entirely) - combined into one
# rich scenario, plus a dedicated SUPPLIER_MISMATCH test.
# ---------------------------------------------------------------------------


def test_detect_discrepancy_covers_every_line_item_discrepancy_type(monkeypatch: pytest.MonkeyPatch) -> None:
    po = {
        "id": 905,
        "supplierId": 41,
        "items": [
            {"productId": 73, "quantity": 8, "price": "820.00"},  # Laptop Pro 14 - quantity differs (5 extracted)
            {"productId": 75, "quantity": 3, "price": "900.00"},  # Mechanical Keyboard - price differs a lot (MEDIUM)
            {"productId": 76, "quantity": 2, "price": "206.00"},  # 27-inch Monitor - price differs a little (LOW)
            {"productId": 77, "quantity": 4, "price": "90.00"},  # USB-C Dock - not on the invoice at all
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/706":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [
                        {"product": "Laptop Pro 14", "quantity": 5, "price": 820},
                        {"product": "Mechanical Keyboard", "quantity": 3, "price": 840},
                        {"product": "27-inch Monitor", "quantity": 2, "price": 200},
                        {"product": "Wireless Mouse", "quantity": 10, "price": 17},  # resolves, but not on the PO
                        {"product": "Bluetooth Speaker", "quantity": 1, "price": 50},  # does not resolve at all
                    ]
                },
            )
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/inventory-transactions/905":
            return httpx.Response(200, json=po)
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(detect_discrepancy(document_id="706", po_id=905, supplier_id=41))
    assert result["hasDiscrepancies"] is True
    assert result["comparedAgainst"] == "purchaseOrderId=905"

    by_type_and_product = {(d["type"], d["productId"]): d for d in result["discrepancies"]}

    quantity = by_type_and_product[("QUANTITY_MISMATCH", 73)]
    assert quantity["expectedValue"] == "8"
    assert quantity["actualValue"] == "5"
    assert quantity["severity"] == "MEDIUM"

    price_medium = by_type_and_product[("PRICE_MISMATCH", 75)]
    assert price_medium["severity"] == "MEDIUM"

    price_low = by_type_and_product[("PRICE_MISMATCH", 76)]
    assert price_low["severity"] == "LOW"

    missing = by_type_and_product[("MISSING_LINE_ITEM", 77)]
    assert missing["expectedValue"] == "quantity 4"
    assert missing["severity"] == "HIGH"

    unexpected_resolved = by_type_and_product[("UNEXPECTED_LINE_ITEM", 74)]
    assert unexpected_resolved["productName"] == "Wireless Mouse"
    assert unexpected_resolved["severity"] == "HIGH"

    unexpected_unresolved = by_type_and_product[("UNEXPECTED_LINE_ITEM", None)]
    assert unexpected_unresolved["productName"] == "Bluetooth Speaker"
    assert "could not be resolved" in unexpected_unresolved["actualValue"]
    assert unexpected_unresolved["severity"] == "HIGH"

    assert len(result["discrepancies"]) == 6


def test_detect_discrepancy_flags_supplier_mismatch_independently(monkeypatch: pytest.MonkeyPatch) -> None:
    """SUPPLIER_MISMATCH is an independent check against the PO's own real
    supplierId - not assumed consistent just because a caller says so.
    Line items are otherwise perfectly clean so SUPPLIER_MISMATCH is the
    only discrepancy raised.
    """
    po = {
        "id": 906,
        "supplierId": 42,  # Cedar Electronics
        "items": [{"productId": 73, "quantity": 5, "price": "820.00"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/707":
            return httpx.Response(
                200, json={"extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}]}
            )
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/inventory-transactions/906":
            return httpx.Response(200, json=po)
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    # supplier_id=41 (TechSource) passed in, but the real PO's own
    # supplierId is 42 (Cedar Electronics) - a genuine mismatch.
    result = asyncio.run(detect_discrepancy(document_id="707", po_id=906, supplier_id=41))
    assert result["hasDiscrepancies"] is True
    assert len(result["discrepancies"]) == 1
    mismatch = result["discrepancies"][0]
    assert mismatch["type"] == "SUPPLIER_MISMATCH"
    assert mismatch["expectedValue"] == "41"
    assert mismatch["actualValue"] == "42"
    assert mismatch["severity"] == "HIGH"


def test_detect_discrepancy_rejects_non_numeric_document_id() -> None:
    with pytest.raises(ValueError):
        asyncio.run(detect_discrepancy(document_id=UNKNOWN_DOCUMENT_ID, po_id=905, supplier_id=41))


def test_detect_discrepancy_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(503, json={"message": "document review service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(detect_discrepancy(document_id="708", po_id=905, supplier_id=41))


# ---------------------------------------------------------------------------
# _merge_order_items/_min_remaining_margin/_select_fulfillment_warehouse:
# pure-logic tests for choose_fulfillment_warehouse()'s resolution and
# tiebreak math - no backend/network involved. _select_fulfillment_warehouse
# is a pure function specifically so its selection algorithm (distance
# first, 50km tie -> stock margin, null-distance fallback) is fully
# unit-testable without any I/O.
# ---------------------------------------------------------------------------


def test_merge_order_items_sums_duplicate_resolved_product_ids() -> None:
    """Two raw line items resolving to the SAME real product must be
    checked as one combined quantity, not two independent ones - the real
    eligible-warehouses endpoint has no dedup logic of its own.
    """
    extracted_items = [
        {"productNameRaw": "27in Monitor", "quantity": 5, "unitPrice": 189.0},
        {"productNameRaw": "27-inch Monitor", "quantity": 3, "unitPrice": 189.0},
    ]
    classifications = [
        {"status": "MATCHED", "id": 76, "name": "27-inch Monitor", "confidence": 100.0, "candidates": []},
        {"status": "MATCHED", "id": 76, "name": "27-inch Monitor", "confidence": 100.0, "candidates": []},
    ]
    resolved, unresolved = _merge_order_items(extracted_items, classifications)
    assert resolved == [{"productId": 76, "quantity": 8}]
    assert unresolved == []


def test_merge_order_items_reports_unresolved_raw_names() -> None:
    extracted_items = [
        {"productNameRaw": "Laptop Pro 14", "quantity": 2, "unitPrice": 850.0},
        {"productNameRaw": "Bluetooth Speaker", "quantity": 1, "unitPrice": 50.0},
    ]
    classifications = [
        {"status": "MATCHED", "id": 73, "name": "Laptop Pro 14", "confidence": 100.0, "candidates": []},
        {"status": "NOT_FOUND", "id": None, "name": None, "confidence": None, "candidates": []},
    ]
    resolved, unresolved = _merge_order_items(extracted_items, classifications)
    assert resolved == [{"productId": 73, "quantity": 2}]
    assert unresolved == ["Bluetooth Speaker"]


def test_merge_order_items_all_unresolved_returns_empty_resolved() -> None:
    extracted_items = [{"productNameRaw": "Mystery Item", "quantity": 1, "unitPrice": None}]
    classifications = [{"status": "NOT_FOUND", "id": None, "name": None, "confidence": None, "candidates": []}]
    resolved, unresolved = _merge_order_items(extracted_items, classifications)
    assert resolved == []
    assert unresolved == ["Mystery Item"]


def test_min_remaining_margin_returns_the_tightest_item() -> None:
    items = [
        {"available": 90, "requestedQuantity": 5},  # margin 85
        {"available": 45, "requestedQuantity": 3},  # margin 42 - the tightest
    ]
    assert _min_remaining_margin(items) == 42


def test_select_fulfillment_warehouse_clear_distance_winner() -> None:
    eligible = [
        {"warehouseId": 1, "warehouseName": "A", "items": [{"available": 50, "requestedQuantity": 10}]},
        {"warehouseId": 2, "warehouseName": "B", "items": [{"available": 20, "requestedQuantity": 10}]},
    ]
    result = _select_fulfillment_warehouse(eligible, {1: 300.0, 2: 50.0})
    assert result["winner_id"] == 2
    assert "nearest" in result["reason"].lower()


def test_select_fulfillment_warehouse_distance_outside_tie_band_ignores_margin() -> None:
    """A 150km gap is well outside the 50km tie band - the closer warehouse
    wins outright even though the farther one has vastly more stock margin.
    """
    eligible = [
        {"warehouseId": 1, "warehouseName": "A", "items": [{"available": 15, "requestedQuantity": 10}]},  # margin 5
        {"warehouseId": 2, "warehouseName": "B", "items": [{"available": 1000, "requestedQuantity": 10}]},  # margin 990
    ]
    result = _select_fulfillment_warehouse(eligible, {1: 50.0, 2: 200.0})
    assert result["winner_id"] == 1


def test_select_fulfillment_warehouse_50km_tie_breaks_on_stock_margin() -> None:
    """The real 50km-adjacent tiebreak scenario, mock/pure-logic-verified -
    real live geocoding never succeeds in this dev environment (see
    choose_fulfillment_warehouse()'s own docstring), so this is the only
    honest way to test it: warehouse 2 is FARTHER (130km vs 100km, a 30km
    gap - within the 50km tie band) but has the much larger stock margin,
    and must win specifically BECAUSE of the tiebreak, not despite it -
    proving the tiebreak actually changes the outcome from pure-distance
    ordering, not just coincidentally agreeing with it.
    """
    eligible = [
        {"warehouseId": 1, "warehouseName": "Closer", "items": [{"available": 30, "requestedQuantity": 10}]},  # margin 20
        {"warehouseId": 2, "warehouseName": "Farther", "items": [{"available": 100, "requestedQuantity": 10}]},  # margin 90
    ]
    result = _select_fulfillment_warehouse(eligible, {1: 100.0, 2: 130.0})
    assert result["winner_id"] == 2
    assert "tied" in result["reason"].lower()
    assert "50" in result["reason"]


def test_select_fulfillment_warehouse_falls_back_to_margin_when_no_distance_confirmed() -> None:
    eligible = [
        {"warehouseId": 1, "warehouseName": "A", "items": [{"available": 15, "requestedQuantity": 10}]},  # margin 5
        {"warehouseId": 2, "warehouseName": "B", "items": [{"available": 50, "requestedQuantity": 10}]},  # margin 40
    ]
    result = _select_fulfillment_warehouse(eligible, {})
    assert result["winner_id"] == 2
    candidates_by_id = {c["warehouseId"]: c for c in result["candidates"]}
    assert candidates_by_id[1]["distanceUnconfirmed"] is True
    assert candidates_by_id[2]["distanceUnconfirmed"] is True
    assert "could not be confirmed" in result["reason"].lower()


def test_select_fulfillment_warehouse_prefers_confirmed_distance_over_unconfirmed() -> None:
    """A warehouse with unconfirmed distance is never silently dropped, but
    is also never preferred over a distance-confirmed alternative - even
    one with a much smaller stock margin.
    """
    eligible = [
        {"warehouseId": 1, "warehouseName": "Unconfirmed", "items": [{"available": 1000, "requestedQuantity": 10}]},
        {"warehouseId": 2, "warehouseName": "Confirmed", "items": [{"available": 15, "requestedQuantity": 10}]},
    ]
    result = _select_fulfillment_warehouse(eligible, {2: 500.0})
    assert result["winner_id"] == 2


def test_select_fulfillment_warehouse_final_tiebreak_is_warehouse_id() -> None:
    eligible = [
        {"warehouseId": 5, "warehouseName": "A", "items": [{"available": 20, "requestedQuantity": 10}]},
        {"warehouseId": 3, "warehouseName": "B", "items": [{"available": 20, "requestedQuantity": 10}]},
    ]
    result = _select_fulfillment_warehouse(eligible, {5: 100.0, 3: 100.0})
    assert result["winner_id"] == 3


def test_select_fulfillment_warehouse_empty_input_returns_no_winner() -> None:
    result = _select_fulfillment_warehouse([], {})
    assert result["winner_id"] is None
    assert result["candidates"] == []


# ---------------------------------------------------------------------------
# choose_fulfillment_warehouse(): wired-path tests against a mocked backend.
# The RECOMMENDED-with-clear-distance-winner path is covered by
# test_order_branch_downstream_chain above. The real 50km-tie scenario
# itself is mock/pure-logic-verified only (see the pure-logic section
# above) - real live geocoding never succeeds in this dev environment
# (GEOAPIFY_API_KEY is an unset placeholder in backend/.env).
# ---------------------------------------------------------------------------


def test_choose_fulfillment_warehouse_no_eligible_warehouse(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/document-review/802":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [{"product": "Laptop Pro 14", "quantity": 500, "price": 850}],
                    "extractedDeliveryCountry": "United Kingdom",
                    "extractedDeliveryRegion": "London",
                },
            )
        if request.url.path == _WAREHOUSE_ELIGIBLE_PATH:
            # A real, empty response - no warehouse has 500 units. The
            # nearest-warehouse endpoint is deliberately NOT stubbed here -
            # it must never be called once eligible-warehouses comes back
            # empty, so an unexpected call there fails this test loudly.
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(choose_fulfillment_warehouse(document_id="802"))
    assert result["status"] == "NO_ELIGIBLE_WAREHOUSE"
    assert result["recommendedWarehouseId"] is None
    assert result["candidates"] == []


def test_choose_fulfillment_warehouse_insufficient_data_when_nothing_resolves(monkeypatch: pytest.MonkeyPatch) -> None:
    """No line item resolves to a real product - INSUFFICIENT_DATA is
    returned immediately, WITHOUT ever calling eligible-warehouses or
    nearest-warehouse (neither is stubbed below, so either call failing
    silently is impossible - it would raise AssertionError instead).
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/document-review/803":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [{"product": "Bluetooth Speaker", "quantity": 2, "price": 50}],
                    "extractedDeliveryCountry": "United Kingdom",
                    "extractedDeliveryRegion": "London",
                },
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(choose_fulfillment_warehouse(document_id="803"))
    assert result["status"] == "INSUFFICIENT_DATA"
    assert result["unresolvedItems"] == ["Bluetooth Speaker"]
    assert result["candidates"] == []


def test_choose_fulfillment_warehouse_reports_unresolved_items_but_still_recommends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One line item resolves (Laptop Pro 14), one doesn't (Bluetooth
    Speaker) - eligibility is still checked for the resolved item, but
    unresolvedItems makes the gap visible rather than silently proceeding
    as if the order only ever had one line item.
    """
    eligible_response = [
        {
            "warehouseId": 1,
            "warehouseName": "London Central",
            "location": "London, United Kingdom",
            "items": [{"productId": 73, "onHand": 50, "reserved": 0, "available": 50, "requestedQuantity": 2}],
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/document-review/804":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [
                        {"product": "Laptop Pro 14", "quantity": 2, "price": 850},
                        {"product": "Bluetooth Speaker", "quantity": 1, "price": 50},
                    ],
                    "extractedDeliveryCountry": "United Kingdom",
                    "extractedDeliveryRegion": "London",
                },
            )
        if request.url.path == _WAREHOUSE_ELIGIBLE_PATH:
            return httpx.Response(200, json=eligible_response)
        if request.url.path == _NEAREST_WAREHOUSE_PATH:
            return httpx.Response(503, json={"message": "geocoding unavailable"})
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(choose_fulfillment_warehouse(document_id="804"))
    assert result["status"] == "RECOMMENDED"
    assert result["recommendedWarehouseId"] == 1
    assert result["unresolvedItems"] == ["Bluetooth Speaker"]
    assert result["candidates"][0]["distanceUnconfirmed"] is True


def test_choose_fulfillment_warehouse_falls_back_when_nearest_warehouse_call_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The nearest-warehouse call's failure is caught specifically (a real,
    confirmed current limitation - GEOAPIFY_API_KEY is an unset placeholder
    in this dev environment, see the tool's own docstring) and degrades to
    margin-only selection, rather than losing step 1's real eligibility
    answer entirely.
    """
    eligible_response = [
        {
            "warehouseId": 1,
            "warehouseName": "London Central",
            "location": "London, United Kingdom",
            "items": [{"productId": 73, "onHand": 20, "reserved": 0, "available": 20, "requestedQuantity": 2}],
        },
        {
            "warehouseId": 2,
            "warehouseName": "Manchester North",
            "location": "Manchester, United Kingdom",
            "items": [{"productId": 73, "onHand": 50, "reserved": 0, "available": 50, "requestedQuantity": 2}],
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/document-review/805":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [{"product": "Laptop Pro 14", "quantity": 2, "price": 850}],
                    "extractedDeliveryCountry": "United Kingdom",
                    "extractedDeliveryRegion": "London",
                },
            )
        if request.url.path == _WAREHOUSE_ELIGIBLE_PATH:
            return httpx.Response(200, json=eligible_response)
        if request.url.path == _NEAREST_WAREHOUSE_PATH:
            return httpx.Response(500, json={"message": "Geoapify returned HTTP 401"})
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(choose_fulfillment_warehouse(document_id="805"))
    assert result["status"] == "RECOMMENDED"
    # Margin: warehouse 1 = 20-2=18, warehouse 2 = 50-2=48 - warehouse 2
    # wins on stock margin since no distance data survived.
    assert result["recommendedWarehouseId"] == 2
    for candidate in result["candidates"]:
        assert candidate["distanceKm"] is None
        assert candidate["distanceUnconfirmed"] is True
    assert "could not be confirmed" in result["reason"].lower()


def test_choose_fulfillment_warehouse_rejects_non_numeric_document_id() -> None:
    with pytest.raises(ValueError):
        asyncio.run(choose_fulfillment_warehouse(document_id=UNKNOWN_DOCUMENT_ID))


def test_choose_fulfillment_warehouse_propagates_not_found_for_unknown_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(404, json={"message": "PendingDocumentReview 999999 not found"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(NotFound):
        asyncio.run(choose_fulfillment_warehouse(document_id="999999"))


def test_choose_fulfillment_warehouse_propagates_typed_backend_error_from_eligible_warehouses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unlike the nearest-warehouse call, a typed error from
    eligible-warehouses (the real correctness filter) is NOT caught - it
    propagates normally, same as every other wired tool in this file.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/document-review/806":
            return httpx.Response(
                200,
                json={
                    "extractedItems": [{"product": "Laptop Pro 14", "quantity": 2, "price": 850}],
                    "extractedDeliveryCountry": "United Kingdom",
                    "extractedDeliveryRegion": "London",
                },
            )
        return httpx.Response(503, json={"message": "warehouse routing service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(choose_fulfillment_warehouse(document_id="806"))


# ---------------------------------------------------------------------------
# _identity_name/_normalize_identity_name/_dates_within_window/
# _totals_close/_jaccard_ratio/_duplicate_signals: pure-logic tests for
# detect_duplicate_document()'s 4 real signals and the >= 3-of-4 decision
# rule - no backend/network involved. Thresholds (3-day window, 0.5
# overlap, 3-of-4) are REASONED DEFAULTS, not empirically calibrated - see
# the wiring investigation.
# ---------------------------------------------------------------------------


def test_identity_name_uses_supplier_for_incoming() -> None:
    review = {"transactionType": "INCOMING", "extractedSupplierName": "TechSource Lebanon", "extractedPartyName": None}
    assert _identity_name(review) == "TechSource Lebanon"


def test_identity_name_uses_party_for_outgoing() -> None:
    review = {"transactionType": "OUTGOING", "extractedSupplierName": None, "extractedPartyName": "Example Customer"}
    assert _identity_name(review) == "Example Customer"


def test_normalize_identity_name_trims_and_lowercases() -> None:
    assert _normalize_identity_name("  TechSource Lebanon  ") == "techsource lebanon"


def test_normalize_identity_name_none_stays_none() -> None:
    assert _normalize_identity_name(None) is None


def test_normalize_identity_name_empty_after_trim_is_none() -> None:
    assert _normalize_identity_name("   ") is None


def test_dates_within_window_true_at_exactly_3_days() -> None:
    assert _dates_within_window("2026-08-15T09:00:00.000Z", "2026-08-18T09:00:00.000Z") is True


def test_dates_within_window_false_just_past_3_days() -> None:
    assert _dates_within_window("2026-08-15T09:00:00.000Z", "2026-08-18T09:00:01.000Z") is False


def test_dates_within_window_false_when_either_side_missing() -> None:
    assert _dates_within_window(None, "2026-08-15T09:00:00.000Z") is False
    assert _dates_within_window("2026-08-15T09:00:00.000Z", None) is False


def test_totals_close_reuses_match_invoice_to_po_tolerance() -> None:
    assert _totals_close(4270.0, 4270.0) is True
    assert _totals_close(4270.0, 4300.0) is True  # diff 30, tolerance max(0.02*4300,1)=86


def test_totals_close_false_outside_tolerance() -> None:
    assert _totals_close(4270.0, 24750.0) is False


def test_totals_close_false_when_either_side_missing() -> None:
    assert _totals_close(None, 100.0) is False
    assert _totals_close(100.0, None) is False


def test_jaccard_ratio_identical_sets_is_one() -> None:
    assert _jaccard_ratio({73, 74}, {73, 74}) == 1.0


def test_jaccard_ratio_partial_overlap() -> None:
    assert _jaccard_ratio({73, 74}, {74, 75}) == pytest.approx(1 / 3)


def test_jaccard_ratio_no_overlap_is_zero() -> None:
    assert _jaccard_ratio({73}, {75}) == 0.0


def test_jaccard_ratio_both_empty_is_none() -> None:
    assert _jaccard_ratio(set(), set()) is None


def test_duplicate_signals_lists_agreed_signals_in_fixed_order() -> None:
    signals = _duplicate_signals(same_identity=True, dates_close=False, totals_close=True, items_overlap=True)
    assert signals == ["supplier", "total", "items"]


def test_duplicate_signals_exactly_3_of_4_is_a_duplicate() -> None:
    signals = _duplicate_signals(same_identity=True, dates_close=True, totals_close=True, items_overlap=False)
    assert len(signals) == 3
    assert len(signals) >= document_tools_module._DUPLICATE_SIGNAL_THRESHOLD


def test_duplicate_signals_exactly_2_of_4_is_not_a_duplicate() -> None:
    signals = _duplicate_signals(same_identity=True, dates_close=True, totals_close=False, items_overlap=False)
    assert len(signals) == 2
    assert len(signals) < document_tools_module._DUPLICATE_SIGNAL_THRESHOLD


# ---------------------------------------------------------------------------
# detect_duplicate_document(): wired-path tests against a mocked backend.
# ---------------------------------------------------------------------------


def test_detect_duplicate_document_finds_and_ranks_real_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    """One rich scenario covering: a same-transactionType candidate that
    genuinely IS a likely duplicate (4/4 signals), one that meets the
    3-of-4 bar via a different combination (date just outside the window,
    everything else agrees), one that shares nothing (0/4, correctly
    excluded), and a different-transactionType candidate that's excluded
    by the pre-filter regardless of how similar its content is (not even
    evaluated). Also proves matches are sorted by most signals first.
    """
    target_review = {
        "transactionType": "INCOMING",
        "extractedSupplierName": "TechSource Lebanon",
        "extractedDate": "2026-08-15T09:00:00.000Z",
        "extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}],
    }
    pending = [
        {"id": 860, **target_review},
        {
            "id": 861,
            "transactionType": "OUTGOING",  # different type - excluded by the pre-filter, never evaluated
            "extractedPartyName": "TechSource Lebanon",
            "extractedDate": "2026-08-15T09:00:00.000Z",
            "extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}],
        },
        {
            "id": 862,  # near-identical - 4/4 signals
            "transactionType": "INCOMING",
            "extractedSupplierName": "TechSource Lebanon",
            "extractedDate": "2026-08-16T09:00:00.000Z",
            "extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}],
        },
        {
            "id": 863,  # shares nothing real - 0/4 signals, correctly excluded
            "transactionType": "INCOMING",
            "extractedSupplierName": "Cedar Electronics",
            "extractedDate": "2026-09-01T09:00:00.000Z",
            "extractedItems": [{"product": "27-inch Monitor", "quantity": 3, "price": 210}],
        },
        {
            "id": 864,  # date outside the 3-day window, everything else agrees - exactly 3/4
            "transactionType": "INCOMING",
            "extractedSupplierName": "TechSource Lebanon",
            "extractedDate": "2026-09-05T09:00:00.000Z",
            "extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}],
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        if request.url.path == "/document-review/860":
            return httpx.Response(200, json=target_review)
        if request.url.path == "/document-review/pending":
            return httpx.Response(200, json=pending)
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(detect_duplicate_document(document_id="860"))
    assert result["isDuplicate"] is True
    assert [m["documentReviewId"] for m in result["matches"]] == [862, 864]

    strongest = result["matches"][0]
    assert strongest["matchedOn"] == ["supplier", "date", "total", "items"]
    assert strongest["extractedIdentityName"] == "TechSource Lebanon"
    assert strongest["totalValue"] == 4100.0
    assert strongest["itemOverlapRatio"] == 1.0

    weaker = result["matches"][1]
    assert weaker["matchedOn"] == ["supplier", "total", "items"]
    assert "date" not in weaker["matchedOn"]


def test_detect_duplicate_document_no_candidates_in_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """The candidate pool is empty once the target excludes itself -
    isDuplicate is False immediately, WITHOUT ever calling GET /products
    (not stubbed below, so an unexpected call there fails this test
    loudly rather than silently passing).
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/865":
            return httpx.Response(
                200,
                json={
                    "transactionType": "INCOMING",
                    "extractedSupplierName": "TechSource Lebanon",
                    "extractedDate": "2026-08-15T09:00:00.000Z",
                    "extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}],
                },
            )
        if request.url.path == "/document-review/pending":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 865,
                        "transactionType": "INCOMING",
                        "extractedSupplierName": "TechSource Lebanon",
                        "extractedDate": "2026-08-15T09:00:00.000Z",
                        "extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}],
                    }
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(detect_duplicate_document(document_id="865"))
    assert result["isDuplicate"] is False
    assert result["matches"] == []


def test_detect_duplicate_document_rejects_non_numeric_document_id() -> None:
    with pytest.raises(ValueError):
        asyncio.run(detect_duplicate_document(document_id=UNKNOWN_DOCUMENT_ID))


def test_detect_duplicate_document_propagates_not_found_for_unknown_document(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        return httpx.Response(404, json={"message": "PendingDocumentReview 999999 not found"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(NotFound):
        asyncio.run(detect_duplicate_document(document_id="999999"))


def test_detect_duplicate_document_propagates_typed_backend_error_from_pending_fetch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/document-review/866":
            return httpx.Response(
                200,
                json={
                    "transactionType": "INCOMING",
                    "extractedSupplierName": "TechSource Lebanon",
                    "extractedDate": "2026-08-15T09:00:00.000Z",
                    "extractedItems": [{"product": "Laptop Pro 14", "quantity": 5, "price": 820}],
                },
            )
        return httpx.Response(503, json={"message": "document review service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(detect_duplicate_document(document_id="866"))


# ---------------------------------------------------------------------------
# match_products()/find_supplier(): live integration tests against a real
# backend, gated by backend_reachable(). Covers an exact match, a typo'd
# match, and the real confirmed "Office" ambiguous tie specifically - real
# evidence this exists, locked in as a permanent regression test per the
# wiring investigation. document_id is a placeholder - unlike the
# still-mocked tools, these two never look it up or validate it (see
# tools.py's module docstring), so any string is accepted.
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_match_products_live_against_real_backend() -> None:
    result = asyncio.run(
        match_products(
            document_id="live-integration-test",
            product_names=["Laptop Pro 14", "Mechnaical Keyboard", "Office"],
        )
    )
    by_raw = {m["productNameRaw"]: m for m in result["matches"]}

    assert by_raw["Laptop Pro 14"]["status"] == "MATCHED"
    assert by_raw["Laptop Pro 14"]["productName"] == "Laptop Pro 14"

    assert by_raw["Mechnaical Keyboard"]["status"] == "MATCHED"
    assert by_raw["Mechnaical Keyboard"]["productName"] == "Mechanical Keyboard"

    assert by_raw["Office"]["status"] == "AMBIGUOUS"
    candidate_names = {c["productName"] for c in by_raw["Office"]["candidates"]}
    assert "Office Headset" in candidate_names
    assert "Office Chair" in candidate_names


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_find_supplier_live_against_real_backend() -> None:
    matched = asyncio.run(find_supplier(document_id="live-integration-test", supplier_name="TechSouce Lebanon"))
    assert matched["status"] == "MATCHED"
    assert matched["supplierName"] == "TechSource Lebanon"

    not_found = asyncio.run(find_supplier(document_id="live-integration-test", supplier_name="Nordic Components AB"))
    assert not_found["status"] == "NOT_FOUND"


# ---------------------------------------------------------------------------
# match_invoice_to_po()/detect_discrepancy(): live integration tests against
# a real backend, gated by backend_reachable(). The investigation found the
# real seeded PENDING_REVIEW document's total (Laptop Pro 14 x5 @820 +
# Wireless Mouse x10 @17 = 4270) doesn't align with either real PENDING
# INCOMING PO's total (TechSource: Laptop x30 @825 = 24750; Cedar
# Electronics: 27-inch Monitor x25 @200 = 5000) - real seed data has no
# document/PO pair aligned closely enough to produce a live MATCHED result
# without adding new seed rows, which is out of this task's scope. What
# real seed data DOES support, with zero synthetic fixtures: a genuine
# NO_MATCH (the totals really do diverge) and a genuine, real discrepancy
# diff against the real TechSource PO - both covered below. MULTIPLE_
# CANDIDATES/INSUFFICIENT_DATA remain mock-only-verified (see the wired
# tests above) - no supplier has 2+ open POs in seed data, and the real
# seeded document is always fully priced.
# ---------------------------------------------------------------------------


async def _discover_live_invoice_fixtures() -> tuple[str, int, int]:
    """Discovers, rather than hardcodes, the real ids these tests need -
    same principle as test_extract_document_live_against_real_backend's
    own discovery of a real pending document. Returns (document_id,
    techsource_supplier_id, techsource_po_id).
    """
    client = get_backend_client()

    pending = await client.get("/document-review/pending")
    assert pending, "Expected at least one real PENDING_REVIEW document in seed data"
    document_id = str(pending[0]["id"])

    suppliers = await client.get("/suppliers")
    techsource = next((s for s in suppliers if s["name"] == "TechSource Lebanon"), None)
    assert techsource is not None, "Expected 'TechSource Lebanon' in real seed data"
    supplier_id = techsource["id"]

    open_pos = await client.get(
        "/inventory-transactions", params={"type": "INCOMING", "status": "PENDING", "supplierId": supplier_id}
    )
    assert open_pos, "Expected at least one real PENDING INCOMING PO for TechSource Lebanon in seed data"
    po_id = open_pos[0]["id"]

    return document_id, supplier_id, po_id


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_match_invoice_to_po_live_no_match_against_real_backend() -> None:
    """Real, as-seeded evidence: the seeded document's extracted total
    (4270) and TechSource's real open PO total (24750) genuinely diverge -
    a real NO_MATCH, not a contrived one. See the module-docstring-level
    note above for why a live MATCHED case needs new seed data this task
    doesn't add.
    """
    document_id, supplier_id, _po_id = asyncio.run(_discover_live_invoice_fixtures())

    result = asyncio.run(match_invoice_to_po(document_id=document_id, supplier_id=supplier_id))
    assert result["status"] == "NO_MATCH"
    assert result["extractedTotal"] is not None
    assert result["purchaseOrderTotal"] is None


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_detect_discrepancy_live_against_real_backend() -> None:
    """Real, as-seeded evidence: comparing the seeded document (Laptop Pro
    14 x5 @820, Wireless Mouse x10 @17) against TechSource's real PO
    (Laptop Pro 14 x30 @825 only) produces two genuine discrepancies -
    QUANTITY_MISMATCH (5 vs 30 - price 820 vs 825 is within tolerance, so
    no PRICE_MISMATCH alongside it) and UNEXPECTED_LINE_ITEM (Wireless
    Mouse resolves to a real product but isn't on this PO) - with no
    SUPPLIER_MISMATCH, since the real PO's supplier genuinely is
    TechSource. Locked in as a permanent regression test using entirely
    real, unmodified seed data - no synthetic fixture needed for this one.
    """
    document_id, supplier_id, po_id = asyncio.run(_discover_live_invoice_fixtures())

    result = asyncio.run(detect_discrepancy(document_id=document_id, po_id=po_id, supplier_id=supplier_id))
    assert result["hasDiscrepancies"] is True
    assert result["comparedAgainst"] == f"purchaseOrderId={po_id}"

    types_by_product = {d["productId"]: d["type"] for d in result["discrepancies"]}
    assert "SUPPLIER_MISMATCH" not in {d["type"] for d in result["discrepancies"]}
    quantity_mismatches = [d for d in result["discrepancies"] if d["type"] == "QUANTITY_MISMATCH"]
    assert quantity_mismatches, f"Expected a real QUANTITY_MISMATCH for Laptop Pro 14. Got: {types_by_product!r}"
    unexpected = [d for d in result["discrepancies"] if d["type"] == "UNEXPECTED_LINE_ITEM"]
    assert unexpected, f"Expected a real UNEXPECTED_LINE_ITEM for Wireless Mouse. Got: {types_by_product!r}"


# ---------------------------------------------------------------------------
# choose_fulfillment_warehouse(): live integration test against a real
# backend, gated by backend_reachable(). There is no real PENDING order-
# type document in seed data (the only PENDING_REVIEW row is the INCOMING
# invoice used above) - GET /document-review/:id has no status filter
# (confirmed by reading document-review.service.ts's getReview()), so the
# real APPROVED OUTGOING seed row (Wireless Mouse x3, "Example Customer")
# is used directly instead. There is no list-all-reviews endpoint to
# discover its id properly, so it's derived as pending_id + 1 (seed.ts
# creates the invoice row, then the approved order row, in that order, in
# a fresh seed) and independently VERIFIED via a real docType=="order"
# check before being trusted - never blindly assumed.
#
# This real seeded document has no extractedDeliveryCountry/Region/Address
# at all, and GEOAPIFY_API_KEY is a confirmed placeholder in this dev
# environment (backend/.env), so real geocoding never succeeds here either
# way - meaning this live test can only exercise the "eligible warehouse
# found, distance unavailable, margin-only fallback" path, NOT the real
# distance-based tiebreak (that stays mock/pure-logic-verified only, see
# the pure-logic section above - same category of limitation as
# match_invoice_to_po's MULTIPLE_CANDIDATES). Still genuinely real,
# unmodified-seed-data coverage of a real code path, not a synthetic one.
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_choose_fulfillment_warehouse_live_against_real_backend() -> None:
    async def _discover_real_order_document_id() -> str:
        client = get_backend_client()
        pending = await client.get("/document-review/pending")
        assert pending, "Expected at least one real PENDING_REVIEW document in seed data"
        candidate_id = str(int(pending[0]["id"]) + 1)

        review = await extract_document(document_id=candidate_id)
        assert review["docType"] == "order", (
            f"Expected document_id={candidate_id} (pending_id + 1) to be the real seeded APPROVED order "
            f"document, but got docType={review['docType']!r} - seed data may have changed."
        )
        assert review["extractedPartyName"] == "Example Customer"
        return candidate_id

    document_id = asyncio.run(_discover_real_order_document_id())

    result = asyncio.run(choose_fulfillment_warehouse(document_id=document_id))
    assert result["status"] == "RECOMMENDED", (
        f"Expected a real warehouse to be stock-eligible for Wireless Mouse x3. Got: {result!r}"
    )
    assert result["recommendedWarehouseId"] is not None
    assert result["unresolvedItems"] == [], "Expected 'Wireless Mouse' to resolve cleanly to a real product"
    assert result["candidates"], "Expected at least one real stock-eligible warehouse"
    for candidate in result["candidates"]:
        assert candidate["distanceKm"] is None
        assert candidate["distanceUnconfirmed"] is True
    assert "could not be confirmed" in result["reason"].lower()


# ---------------------------------------------------------------------------
# detect_duplicate_document(): live integration test against a real
# backend, gated by backend_reachable(). Real seed data currently has
# exactly ONE PENDING_REVIEW document at a time (confirmed in the wiring
# investigation) - so once that document excludes itself from its own
# candidate pool, there is nothing left to compare against. This means a
# genuine "duplicate found" result is NOT achievable live with current
# seed data (there is no second simultaneously-pending document to form a
# real pair) and stays mock/pure-logic-verified only (see
# test_detect_duplicate_document_finds_and_ranks_real_candidates above) -
# same category of limitation as match_invoice_to_po's MULTIPLE_CANDIDATES
# and choose_fulfillment_warehouse's 50km tie. What IS real, live
# coverage: the "no duplicate found" path against a genuinely empty
# candidate pool, not a contrived one.
# ---------------------------------------------------------------------------


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_detect_duplicate_document_live_no_duplicate_against_real_backend() -> None:
    async def _discover_real_pending_document_id() -> str:
        client = get_backend_client()
        pending = await client.get("/document-review/pending")
        assert pending, "Expected at least one real PENDING_REVIEW document in seed data"
        return str(pending[0]["id"])

    document_id = asyncio.run(_discover_real_pending_document_id())

    result = asyncio.run(detect_duplicate_document(document_id=document_id))
    assert result["documentId"] == document_id
    assert result["isDuplicate"] is False, (
        f"Expected no duplicate - real seed data has only one PENDING_REVIEW document at a time, "
        f"so the candidate pool should be empty once it excludes itself. Got: {result!r}"
    )
    assert result["matches"] == []


@pytest.mark.skipif(
    not settings.openai_api_key,
    reason="OPENAI_API_KEY not set - skipping live-model smoke test",
)
def test_document_agent_live_openai_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end smoke test against a real model (OpenAI provider), with
    the still-mocked downstream tools.

    Only runs when OPENAI_API_KEY is present. Exercises build_document_agent()
    -> settings.build_model("document") -> a real OpenAI chat completion.
    Deliberately gives the model already-extracted data inline (see the
    module docstring) instead of inviting it to call the now-real
    extract_document() with a fictional document_id, which would fail for
    an unrelated reason (extract_document() needs a real numeric id and a
    real backend) and isn't what this test is meant to verify - the OpenAI
    provider wiring itself, not the full pipeline. Asserts a non-empty,
    coherent response - not any specific wording, since model output varies.
    match_products() is real too (2026-08-22) - patched via
    httpx.MockTransport (real catalog fixtures) so this stays
    backend-independent, live-model-only, exactly as before.
    """
    _patch_catalog_backend(monkeypatch)
    agent = build_document_agent()
    result = agent(
        f"The document with document_id={_INVOICE_PROMPT_PLACEHOLDER_DOCUMENT_ID} has ALREADY been extracted - "
        "do not call extract_document for it. Here is its already-extracted invoice data: supplier "
        "Nordic Components AB, 60 units USB-C Docking Station 100W, 30 units Wireless Optical Mouse. "
        "Match these line items against our product catalog and, in one short sentence, tell me "
        "whether anything needs my attention."
    )
    text = str(result).strip()
    assert text, "Expected a non-empty response from the live model"
    assert len(text) > 15, f"Response looked too short to be coherent: {text!r}"


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping tool-error handling smoke test",
)
def test_document_agent_reports_tool_error_instead_of_fabricating(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression test for a real bug caught in local testing.

    After a tool call errored, the agent narrated a "corrected" retry in its
    reasoning text but never actually made a second tool call, then
    asserted success with fabricated data. This forces match_products to
    fail on its first call for a real, known document and asserts the
    agent's final answer is honest about it: either it genuinely retried
    (a second real call recorded below) or it clearly told the user the
    action failed - never that it silently claimed success. Deliberately
    gives already-extracted data inline (see module docstring) rather than
    inviting a call to the now-real extract_document() with a fictional
    document_id.

    match_products() is real now (2026-08-22) - the flakiness injection
    moved from monkeypatching the (now-unused) mocks.match_products_mock to
    failing the first real GET /products call via httpx.MockTransport
    instead: same effect, force match_products()'s first call to fail and
    verify the agent doesn't silently fabricate a result.
    """
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(503, json={"message": "Simulated transient failure from the product catalog service."})
            return httpx.Response(200, json=_REAL_PRODUCT_ROWS)
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    agent = build_document_agent()
    result = agent(
        f"The document with document_id={_INVOICE_PROMPT_PLACEHOLDER_DOCUMENT_ID} has ALREADY been extracted - "
        "do not call extract_document for it. Here is its already-extracted invoice data: supplier "
        "Nordic Components AB, 60 units USB-C Docking Station 100W, 30 units Wireless Optical Mouse. "
        "Match these line items against our product catalog and tell me the result."
    )
    text = str(result).strip()
    assert text, "Expected a non-empty response from the live model"

    if calls["n"] >= 2:
        # The agent genuinely retried the failed tool call - acceptable,
        # regardless of what the final text says.
        return

    failure_language = (
        "fail",
        "error",
        "couldnt",
        "could not",
        "cannot",
        "cant",
        "unable",
        "issue",
        "problem",
        "trouble",
        "retry",
        "try again",
    )
    # NOTE: deliberately not "again" alone - it's a substring of "against"
    # ("...products in the invoice against our catalog"), which produced a
    # false-positive pass in local testing against a real model. Word-level
    # terms below are still checked as substrings, so prefer specific
    # multi-character words/phrases unlikely to appear inside unrelated text.
    # Apostrophes are stripped from both sides (straight and the two curly
    # variants, via \N{...} named escapes - pure ASCII source, see
    # test_insights_agent.py::test_insights_agent_declines_expiry_questions_honestly
    # for why a literal curly apostrophe is unsafe in this file) so 
    # "can't"/"can\u2019t"/"cant" all match "cant" regardless of which
    # apostrophe variant a real model response happens to use.
    _apostrophes = "'" + "\N{RIGHT SINGLE QUOTATION MARK}" + "\N{LEFT SINGLE QUOTATION MARK}"
    lowered = "".join(ch for ch in text.lower() if ch not in _apostrophes)
    assert any(term in lowered for term in failure_language), (
        "Agent neither retried the failed tool call nor reported failure - "
        f"looks like a fabricated success. Response: {text!r}"
    )
