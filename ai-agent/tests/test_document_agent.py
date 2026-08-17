"""Smoke tests for the Document agent - both the invoice and order branches.

Most of these call the @tool-decorated functions directly so they run
without any credentials or network access, and verify the standalone agent
builds independently of the Supervisor.

Two additional tests actually call a real model (test_document_agent_live_openai_smoke
via the OpenAI provider specifically, test_document_agent_reports_tool_error_instead_of_fabricating
via whichever provider is configured) - see tests/_helpers.py for the skip
conditions. Neither touches a real backend - the tools they exercise stay
fully mocked.
"""

from __future__ import annotations

import pytest

from agents.document_agent.agent import DOCUMENT_TOOLS, build_document_agent
from agents.document_agent.tools import (
    choose_fulfillment_warehouse,
    detect_discrepancy,
    detect_duplicate_document,
    extract_document,
    find_customer,
    find_supplier,
    match_invoice_to_po,
    match_products,
)
from config.settings import settings
from tests._helpers import live_model_configured
from tools.mocks import document_mock_data
from tools.mocks.document_mock_data import (
    KNOWN_INVOICE_DOCUMENT_ID,
    KNOWN_ORDER_DOCUMENT_ID,
    DocumentNotFoundError,
    detect_discrepancy_mock,
    detect_duplicate_document_mock,
)

UNKNOWN_DOCUMENT_ID = "doc_totally_made_up_id"


def test_document_agent_builds_standalone() -> None:
    """The Document agent must construct without any Supervisor dependency."""
    agent = build_document_agent()
    assert agent.name == "document_agent"
    assert len(DOCUMENT_TOOLS) == 8


def test_extract_document_invoice_branch() -> None:
    result = extract_document(document_id=KNOWN_INVOICE_DOCUMENT_ID, doc_type="invoice")
    assert result["documentId"] == KNOWN_INVOICE_DOCUMENT_ID
    assert result["docType"] == "invoice"
    assert result["extractedSupplierName"]
    assert result["extractedItems"]


def test_extract_document_order_branch() -> None:
    result = extract_document(document_id=KNOWN_ORDER_DOCUMENT_ID, doc_type="order")
    assert result["documentId"] == KNOWN_ORDER_DOCUMENT_ID
    assert result["docType"] == "order"
    assert result["extractedPartyName"]
    assert result["extractedItems"]


def test_extract_document_rejects_invalid_doc_type() -> None:
    with pytest.raises(Exception):
        extract_document(document_id=KNOWN_INVOICE_DOCUMENT_ID, doc_type="something_else")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Regression tests: a document-specific tool must refuse to fabricate a
# result for a document_id that was never actually provided. This is the
# exact bug caught in local testing - match_invoice_to_po and
# detect_discrepancy returned a specific, plausible-sounding but entirely
# made-up result despite no invoice ever being provided in the conversation.
# ---------------------------------------------------------------------------


def test_extract_document_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        extract_document(document_id=UNKNOWN_DOCUMENT_ID, doc_type="invoice")


def test_match_invoice_to_po_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        match_invoice_to_po(document_id=UNKNOWN_DOCUMENT_ID, supplier_id=5, extracted_total=2070.00)


def test_detect_discrepancy_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        detect_discrepancy(document_id=UNKNOWN_DOCUMENT_ID, compare_against="purchaseOrderId=482")


def test_detect_duplicate_document_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        detect_duplicate_document(document_id=UNKNOWN_DOCUMENT_ID)


def test_match_products_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        match_products(document_id=UNKNOWN_DOCUMENT_ID, product_names=["Wireless Optical Mouse"])


def test_find_supplier_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        find_supplier(document_id=UNKNOWN_DOCUMENT_ID, supplier_name="Nordic Components AB")


def test_find_customer_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        find_customer(document_id=UNKNOWN_DOCUMENT_ID, party_name="Bluewater Retail Group")


def test_choose_fulfillment_warehouse_rejects_unknown_document_id() -> None:
    with pytest.raises(DocumentNotFoundError):
        choose_fulfillment_warehouse(
            document_id=UNKNOWN_DOCUMENT_ID, product_ids=[103, 108], delivery_region="Greater Manchester"
        )


def test_invoice_branch_end_to_end() -> None:
    """extract -> match_products -> find_supplier -> match_invoice_to_po."""
    extracted = extract_document(document_id=KNOWN_INVOICE_DOCUMENT_ID, doc_type="invoice")
    product_names = [item["productNameRaw"] for item in extracted["extractedItems"]]

    matched = match_products(document_id=KNOWN_INVOICE_DOCUMENT_ID, product_names=product_names)
    assert len(matched["matches"]) == len(product_names)

    supplier = find_supplier(
        document_id=KNOWN_INVOICE_DOCUMENT_ID, supplier_name=extracted["extractedSupplierName"]
    )
    assert supplier["status"] == "MATCHED"
    assert supplier["supplierId"] is not None

    po_match = match_invoice_to_po(
        document_id=KNOWN_INVOICE_DOCUMENT_ID, supplier_id=supplier["supplierId"], extracted_total=2070.00
    )
    assert po_match["status"] in {"MATCHED", "NO_MATCH", "MULTIPLE_CANDIDATES"}


def test_order_branch_end_to_end() -> None:
    """extract -> match_products -> find_customer -> choose_fulfillment_warehouse."""
    extracted = extract_document(document_id=KNOWN_ORDER_DOCUMENT_ID, doc_type="order")
    product_names = [item["productNameRaw"] for item in extracted["extractedItems"]]

    matched = match_products(document_id=KNOWN_ORDER_DOCUMENT_ID, product_names=product_names)
    matched_product_ids = [m["productId"] for m in matched["matches"] if m["productId"] is not None]
    assert matched_product_ids

    customer = find_customer(
        document_id=KNOWN_ORDER_DOCUMENT_ID, party_name=extracted["extractedPartyName"]
    )
    assert customer["status"] == "MATCHED"
    assert customer["customerId"] is not None

    warehouse = choose_fulfillment_warehouse(
        document_id=KNOWN_ORDER_DOCUMENT_ID,
        product_ids=matched_product_ids,
        delivery_region=extracted["extractedDeliveryRegion"],
    )
    assert warehouse["recommendedWarehouseId"] is not None
    assert len(warehouse["candidates"]) > 1


def test_detect_duplicate_document_example_cases() -> None:
    """The mock data module exposes both a not-duplicate and a duplicate case."""
    not_dup = detect_duplicate_document_mock(document_id=KNOWN_INVOICE_DOCUMENT_ID, is_duplicate=False)
    assert not_dup["isDuplicate"] is False
    assert not_dup["matches"] == []

    dup = detect_duplicate_document_mock(document_id=KNOWN_INVOICE_DOCUMENT_ID, is_duplicate=True)
    assert dup["isDuplicate"] is True
    assert len(dup["matches"]) > 0
    assert dup["matches"][0]["similarityScore"] > 0.9


def test_detect_discrepancy_example_cases() -> None:
    """The mock data module exposes both a clean and a discrepant case."""
    clean = detect_discrepancy_mock(document_id=KNOWN_INVOICE_DOCUMENT_ID, has_discrepancies=False)
    assert clean["hasDiscrepancies"] is False
    assert clean["discrepancies"] == []

    discrepant = detect_discrepancy_mock(document_id=KNOWN_INVOICE_DOCUMENT_ID, has_discrepancies=True)
    assert discrepant["hasDiscrepancies"] is True
    assert len(discrepant["discrepancies"]) > 0
    assert discrepant["discrepancies"][0]["severity"] in {"LOW", "MEDIUM", "HIGH"}


def test_detect_duplicate_document_tool_returns_well_formed_response() -> None:
    result = detect_duplicate_document(document_id=KNOWN_INVOICE_DOCUMENT_ID)
    assert result["documentId"] == KNOWN_INVOICE_DOCUMENT_ID
    assert isinstance(result["isDuplicate"], bool)
    assert isinstance(result["matches"], list)


def test_detect_discrepancy_tool_returns_well_formed_response() -> None:
    result = detect_discrepancy(
        document_id=KNOWN_INVOICE_DOCUMENT_ID,
        compare_against="purchaseOrderId=482",
    )
    assert result["documentId"] == KNOWN_INVOICE_DOCUMENT_ID
    assert isinstance(result["hasDiscrepancies"], bool)
    assert isinstance(result["discrepancies"], list)


@pytest.mark.skipif(
    not settings.openai_api_key,
    reason="OPENAI_API_KEY not set - skipping live-model smoke test",
)
def test_document_agent_live_openai_smoke() -> None:
    """End-to-end smoke test against a real model (OpenAI provider), with mocked tools.

    Only runs when OPENAI_API_KEY is present. Exercises build_document_agent()
    -> settings.build_model("document") -> a real OpenAI chat completion,
    while the tool data underneath stays fully mocked. Asserts a non-empty,
    coherent response - not any specific wording, since model output varies.
    """
    agent = build_document_agent()
    result = agent(
        f"An invoice (doc_type=invoice, document_id={KNOWN_INVOICE_DOCUMENT_ID}) was just "
        "uploaded. Process it and, in one short sentence, tell me the supplier "
        "and whether anything needs my attention."
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
    action failed - never that it silently claimed success.
    """
    calls = {"n": 0}
    original_match_products_mock = document_mock_data.match_products_mock

    def flaky_match_products_mock(document_id: str, product_names: list[str]) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Simulated transient failure from the product catalog service.")
        return original_match_products_mock(document_id=document_id, product_names=product_names)

    monkeypatch.setattr(document_mock_data, "match_products_mock", flaky_match_products_mock)

    agent = build_document_agent()
    result = agent(
        f"An invoice (doc_type=invoice, document_id={KNOWN_INVOICE_DOCUMENT_ID}) was just "
        "uploaded. Process it fully and tell me the result."
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
        "couldn't",
        "could not",
        "cannot",
        "can't",
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
    lowered = text.lower()
    assert any(term in lowered for term in failure_language), (
        "Agent neither retried the failed tool call nor reported failure - "
        f"looks like a fabricated success. Response: {text!r}"
    )
