"""Offline tests for the real Document Agent backend wiring."""

from __future__ import annotations

import json
import inspect
from unittest.mock import Mock, patch

import agents.document_agent.tools as document_tools_module
from agents.document_agent.agent import DOCUMENT_TOOLS, _extract_review_handoff, build_document_agent
from agents.document_agent.tools import (
    approve_document_review,
    get_document_review,
    get_pending_document_reviews,
    reject_document_review,
    resolve_document_product,
    resolve_document_supplier,
)


def transaction_row(transaction_type="INCOMING", source=None, destination=None, supplier=None):
    return {
        "id": 91, "type": transaction_type, "status": "PENDING",
        "sourceWarehouseId": source, "destinationWarehouseId": destination,
        "supplierId": supplier, "deliveryCountry": "Lebanon",
        "deliveryRegion": "Beirut", "deliveryAddress": "Port district",
        "expectedDate": "2026-09-01T00:00:00.000Z", "actualDate": None,
        "partyName": "Customer" if transaction_type == "OUTGOING" else None,
        "documentUrl": "s3://private/review.pdf",
        "createdAt": "2026-08-21T10:00:00.000Z",
        "updatedAt": "2026-08-21T10:00:00.000Z",
        "items": [{"id": 301, "transactionId": 91, "productId": 42,
                   "quantity": 5, "price": "12.50" if transaction_type == "INCOMING" else None}],
    }


def review_row(review_id=7, transaction_type="INCOMING", status="PENDING_REVIEW", transaction=None):
    return {
        "id": review_id, "documentUrl": "s3://private/review.pdf",
        "documentKey": "documents/review.pdf", "transactionType": transaction_type,
        "extractedPartyName": None, "extractedSupplierName": "Acme Supply",
        "extractedDate": "2026-08-20T00:00:00.000Z",
        "extractedWarehouseName": "Main", "extractedDeliveryCountry": "Lebanon",
        "extractedDeliveryRegion": "Beirut", "extractedDeliveryAddress": "Port district",
        "extractedItems": [{"product": "Widget", "quantity": 5, "price": 12.5}],
        "status": status, "rejectionReason": None, "reviewedById": None,
        "reviewedAt": None, "transactionId": transaction["id"] if transaction else None,
        "createdAt": "2026-08-20T10:00:00.000Z", "updatedAt": "2026-08-20T10:00:00.000Z",
        "transaction": transaction, "reviewedBy": None,
    }


def client_returning(response):
    client = Mock()
    client.get.return_value = response
    client.post.return_value = response
    return Mock(return_value=client), client


def test_document_agent_registers_only_real_backend_tools():
    agent = build_document_agent()
    assert len(DOCUMENT_TOOLS) == 6
    assert set(agent.tool_names) == {
        "get_pending_document_reviews", "get_document_review",
        "resolve_document_product", "resolve_document_supplier",
        "approve_document_review", "reject_document_review",
    }
    source = inspect.getsource(document_tools_module)
    assert "tools.mocks" not in source
    assert "query_database" not in source
    for unsupported in (
        "match_invoice_to_po", "find_customer", "detect_duplicate_document",
        "detect_discrepancy", "choose_fulfillment_warehouse",
    ):
        assert unsupported not in agent.tool_names


def test_pending_and_single_review_call_exact_endpoints_and_preserve_evidence():
    constructor, client = client_returning([review_row()])
    with patch("agents.document_agent.tools.BackendHttpClient", constructor):
        pending = get_pending_document_reviews()
    client.get.assert_called_once_with("/document-review/pending")
    assert pending["reviews"][0]["transactionType"] == "INCOMING"

    row = review_row()
    row["reviewedBy"] = {"id": 3, "name": "Admin", "email": "a@b.test",
                         "role": "ADMIN", "passwordHash": "must-not-leak"}
    constructor, client = client_returning(row)
    with patch("agents.document_agent.tools.BackendHttpClient", constructor):
        review = get_document_review(7)
    client.get.assert_called_once_with("/document-review/7")
    assert review["extractedItems"][0]["quantity"] == 5
    assert "passwordHash" not in review["reviewedBy"]


def test_resolution_tools_call_exact_backend_queries():
    constructor, client = client_returning([{"productId": 42, "name": "Widget", "score": 1.0}])
    with patch("agents.document_agent.tools.BackendHttpClient", constructor):
        result = resolve_document_product("Widget")
    client.get.assert_called_once_with("/document-review/resolve-product", query={"query": "Widget"})
    assert result["suggestions"][0]["productId"] == 42

    constructor, client = client_returning([{"supplierId": 5, "name": "Acme", "score": 1.0}])
    with patch("agents.document_agent.tools.BackendHttpClient", constructor):
        result = resolve_document_supplier("Acme")
    client.get.assert_called_once_with("/document-review/resolve-supplier", query={"query": "Acme"})
    assert result["suggestions"][0]["supplierId"] == 5


def test_incoming_approval_exact_body_has_no_reviewed_by_id():
    transaction = transaction_row(destination=2, supplier=5)
    constructor, client = client_returning(review_row(status="APPROVED", transaction=transaction))
    with patch("agents.document_agent.tools.BackendHttpClient", constructor):
        result = approve_document_review(
            7, [{"productId": 42, "quantity": 5, "price": 12.5}],
            expected_date="2026-09-01T00:00:00Z", supplier_id=5,
            destination_warehouse_id=2,
        )
    body = client.post.call_args.kwargs["json_body"]
    client.post.assert_called_once_with("/document-review/7/approve", json_body=body)
    assert body == {"items": [{"productId": 42, "quantity": 5, "price": 12.5}],
                    "expectedDate": "2026-09-01T00:00:00Z", "supplierId": 5,
                    "destinationWarehouseId": 2}
    assert "reviewedById" not in body
    assert result["transaction"]["supplierId"] == 5


def test_outgoing_approval_preserves_source_warehouse_and_party():
    transaction = transaction_row("OUTGOING", source=4)
    constructor, client = client_returning(
        review_row(transaction_type="OUTGOING", status="APPROVED", transaction=transaction)
    )
    with patch("agents.document_agent.tools.BackendHttpClient", constructor):
        approve_document_review(8, [{"productId": 42, "quantity": 5}],
                                source_warehouse_id=4, party_name="Customer",
                                delivery_country="Lebanon", delivery_region="Beirut",
                                delivery_address="Port district")
    body = client.post.call_args.kwargs["json_body"]
    assert body["sourceWarehouseId"] == 4
    assert body["partyName"] == "Customer"
    assert "supplierId" not in body and "destinationWarehouseId" not in body
    assert "reviewedById" not in body


def test_rejection_uses_real_endpoint_and_dto():
    row = review_row(status="REJECTED")
    row["rejectionReason"] = "Unreadable quantities"
    constructor, client = client_returning(row)
    with patch("agents.document_agent.tools.BackendHttpClient", constructor):
        result = reject_document_review(7, "Unreadable quantities")
    client.post.assert_called_once_with("/document-review/7/reject",
                                        json_body={"rejectionReason": "Unreadable quantities"})
    assert result["status"] == "REJECTED"


def test_structured_handoff_preserves_item_quantity_and_warehouse_context():
    payload = review_row(transaction_type="OUTGOING", status="APPROVED",
                         transaction=transaction_row("OUTGOING", source=4))
    messages = [
        {"content": [{"toolUse": {"toolUseId": "a", "name": "approve_document_review", "input": {}}}]},
        {"content": [{"toolResult": {"toolUseId": "a", "content": [{"text": json.dumps(payload)}]}}]},
    ]
    assert _extract_review_handoff(messages) == {
        "review_id": 7, "transaction_type": "OUTGOING", "product_ids": [42],
        "items": [{"product_id": 42, "quantity": 5}],
        "requested_quantities": [{"product_id": 42, "quantity": 5}],
        "source_warehouse_id": 4, "destination_warehouse_id": None,
        "supplier_id": None,
    }
