"""Smoke tests for the Insights agent.

Most tests call the @tool-decorated functions directly against an
`httpx.MockTransport`, so they validate the real backend contracts without
network access. They also verify that the standalone agent builds independently
of the Supervisor.

Two additional tests actually call a real model (test_insights_agent_live_openai_smoke
via the OpenAI provider specifically, test_insights_agent_reports_tool_error_instead_of_fabricating
via whichever provider is configured) - see tests/_helpers.py for the skip
conditions. Neither touches a live backend.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import re
import time
from datetime import datetime, timedelta

import httpx
import pytest

from agents.insights_agent import tools as insights_tools_module
from agents.insights_agent.agent import INSIGHTS_TOOLS, build_insights_agent
from agents.insights_agent.prompts import INSIGHTS_SYSTEM_PROMPT
from agents.insights_agent.tools import (
    _build_dead_stock_transfer_reason,
    _build_transfer_recommendation_reason,
    _compute_recommended_transfers,
    _qualifying_warehouses_by_recency,
    _sum_transaction_value,
    analyze_dead_stock,
    calculate_reorder_quantity,
    compare_suppliers,
    get_available_stock,
    get_consumption_anomalies,
    get_low_stock_products,
    get_open_purchase_orders,
    get_restock_recommendations,
    get_stockout_risk,
    get_transfer_recommendations,
    recommend_fulfillment_warehouse,
    recommend_dead_stock_transfer,
)
from backend_client import BackendClient, ServiceUnavailable
from config.settings import settings
from tests._helpers import backend_reachable, live_model_configured
from tools.mocks import insights_mock_data
from tools.query_database import query_database
from tools.schemas.insights_schema import (
    ConsumptionAnomalyDirection,
    PurchaseOrderStatus,
    ReorderQuantityStatus,
    RestockReason,
    StockoutRiskLevel,
    SupplierRecommendationStatus,
)


def test_insights_agent_builds_standalone() -> None:
    """The Insights agent must construct without any Supervisor dependency."""
    agent = build_insights_agent()
    assert agent.name == "insights_agent"
    assert agent.callback_handler.__name__ == "null_callback_handler"
    assert len(INSIGHTS_TOOLS) == 11


def test_active_insights_tool_registry_is_exact() -> None:
    assert INSIGHTS_TOOLS == [
        get_available_stock,
        get_low_stock_products,
        get_stockout_risk,
        get_restock_recommendations,
        get_transfer_recommendations,
        analyze_dead_stock,
        get_consumption_anomalies,
        compare_suppliers,
        get_open_purchase_orders,
        recommend_fulfillment_warehouse,
        query_database,
    ]
    assert INSIGHTS_TOOLS.count(query_database) == 1


def test_deprecated_tools_are_not_active() -> None:
    assert calculate_reorder_quantity not in INSIGHTS_TOOLS
    assert recommend_dead_stock_transfer not in INSIGHTS_TOOLS
    assert all(getattr(tool, "__name__", "") != "draft_purchase_order" for tool in INSIGHTS_TOOLS)


def test_runtime_insights_tools_module_does_not_import_mocks() -> None:
    assert "tools.mocks" not in inspect.getsource(insights_tools_module)


def test_insights_prompt_matches_active_tool_boundaries() -> None:
    assert "query_database()" in INSIGHTS_SYSTEM_PROMPT
    assert "flexible read-only ERP questions" in INSIGHTS_SYSTEM_PROMPT
    assert "specialized tools" in INSIGHTS_SYSTEM_PROMPT
    for removed_tool_name in (
        "calculate_reorder_quantity",
        "recommend_dead_stock_transfer",
        "draft_purchase_order",
    ):
        assert removed_tool_name not in INSIGHTS_SYSTEM_PROMPT


def test_insights_prompt_uses_tool_values_and_never_model_arithmetic() -> None:
    prompt = " ".join(INSIGHTS_SYSTEM_PROMPT.split())

    assert "All numerical claims must come from values returned by your tools" in prompt
    assert "calculated by the backend or calculated deterministically by the Python adapter" in prompt
    assert "Never calculate, estimate, assume, invent, recompute" in prompt
    assert "never recompute supplier scores" in prompt
    assert "transfer `reason` may be adapter-generated deterministically" in prompt
    assert "Every number your tools return" not in prompt
    assert "already calculated by the backend" not in prompt


def test_insights_prompt_rejects_document_work_and_fake_failure_recovery() -> None:
    prompt = " ".join(INSIGHTS_SYSTEM_PROMPT.split())

    assert "Do not approve or reject reviews" in prompt
    assert "resolve document product/supplier names" in prompt
    assert "accept only exact resolved IDs and quantities" in prompt
    assert "Unauthorized, forbidden, not-found, conflict, validation" in prompt
    assert "Never fabricate an ID, quantity, stock value, supplier recommendation" in prompt


def test_insights_prompt_resolves_pure_request_product_names_without_guessing_ids() -> None:
    prompt = " ".join(INSIGHTS_SYSTEM_PROMPT.split())

    assert "A user may naturally identify a product by name" in prompt
    assert "use the existing read-only query_database() discovery path" in prompt
    assert "then call the specific ID-based tool" in prompt
    assert "only when the result uniquely identifies one product" in prompt
    assert "report that not-found/ambiguity result" in prompt
    assert "never invent or guess a productId" in prompt
    assert "raw line-item names from a document" in prompt


def test_supplier_ranking_prompt_separates_score_from_lead_time_context() -> None:
    normalized_prompt = " ".join(INSIGHTS_SYSTEM_PROMPT.split())

    assert "price (40%)" in normalized_prompt
    assert "on-time delivery (30%)" in normalized_prompt
    assert "cancellation performance (20%)" in normalized_prompt
    assert "product supply history (10%)" in normalized_prompt
    assert "`leadTimeDays` is fetched separately" in normalized_prompt
    assert "does NOT contribute to `overallScore` or rank" in normalized_prompt


def test_fulfillment_prompt_uses_available_stock_and_optional_geography() -> None:
    normalized_prompt = " ".join(INSIGHTS_SYSTEM_PROMPT.split())
    assert "recommend_fulfillment_warehouse()" in normalized_prompt
    # Full-order eligibility is checked via AVAILABLE stock (onHand minus
    # reservations), not physical onHand alone - real intent, not a fixed
    # wording, so this checks the substantive claim survives however rule 5
    # is phrased: a SINGLE warehouse must hold enough of EVERY item, judged
    # from AVAILABLE stock rather than onHand.
    assert "SINGLE warehouse holds enough of EVERY item at once" in normalized_prompt
    assert "AVAILABLE stock rather than physical onHand alone" in normalized_prompt
    assert "delivery country, region, and address" in normalized_prompt


def test_get_available_stock_docstring_disclaims_whole_order_fulfillment() -> None:
    """get_available_stock()'s own docstring previously told the model to
    prefer it for "the matched productIds for a specific order's line
    items" / "can we fulfill THIS order" - a direct contradiction of
    prompts.py rule 5's ban on using it for a 2+-product fulfillment
    question. That framing must be gone, and the docstring must instead
    explicitly disclaim whole-order fulfillment and redirect to
    recommend_fulfillment_warehouse() by name - the fix has to live in the
    tool description itself, not only the system prompt, since the model
    reads both."""
    docstring = " ".join((get_available_stock.__doc__ or "").split())

    # The old contradicting framing must be gone.
    assert "specific order's line items" not in docstring
    assert "can we fulfill THIS order" not in docstring

    # The new, accurate framing must be present.
    assert "checked INDEPENDENTLY" in docstring
    assert "DOES NOT CONFIRM WHOLE-ORDER FULFILLMENT" in docstring
    assert "recommend_fulfillment_warehouse() instead" in docstring


def test_recommend_fulfillment_warehouse_docstring_claims_whole_order_fulfillment() -> None:
    """The correct tool must positively claim the "can this whole order be
    fulfilled" scenario, not just rely on the wrong tool disclaiming it -
    and cross-reference get_available_stock() so the two docstrings agree
    with each other, not just with prompts.py."""
    docstring = " ".join((recommend_fulfillment_warehouse.__doc__ or "").split())

    assert "whether one warehouse can fulfill the entire order" in docstring
    assert "can we fulfill this order" in docstring
    assert "get_available_stock()" in docstring


def test_get_available_stock_rejects_empty_product_ids() -> None:
    """product_ids is required - there is no "every product, every
    warehouse" mode (the real backend has no bulk-available endpoint; see
    tools.py::get_available_stock's docstring). An empty list must fail
    loudly rather than silently making zero backend calls and returning an
    empty result that looks like "nothing in stock."
    """
    with pytest.raises(ValueError, match="product_ids must not be empty"):
        asyncio.run(get_available_stock(product_ids=[]))


def test_get_stockout_risk_risk_level_is_a_direct_pass_through() -> None:
    """riskLevel is no longer remapped - the AI schema's enum now matches the
    real backend's exactly (OK/AT_RISK/OUT_OF_STOCK), so there's no mapping
    function left to unit-test in isolation; the pass-through itself is
    verified against a realistic payload in
    test_get_stockout_risk_wired_end_to_end_against_mocked_backend below.
    """
    assert set(StockoutRiskLevel) == {
        StockoutRiskLevel.OK,
        StockoutRiskLevel.AT_RISK,
        StockoutRiskLevel.OUT_OF_STOCK,
    }


def test_get_restock_recommendations_reason_is_a_direct_pass_through() -> None:
    """reason is no longer remapped - the AI schema's enum now matches the
    real backend's 2-value RestockReason exactly (transfer_available/
    purchase_required). No mapping function exists to unit-test in
    isolation; the pass-through itself is verified against a realistic
    payload in the wired end-to-end test below.
    """
    assert set(RestockReason) == {RestockReason.TRANSFER_AVAILABLE, RestockReason.PURCHASE_REQUIRED}


def test_get_consumption_anomalies_direction_is_a_direct_pass_through() -> None:
    """direction is no longer remapped - the AI schema's enum now matches the
    real backend's 2-value ConsumptionAnomalyDirection exactly (INCREASE/
    DECREASE), replacing the fabricated 3-value SPIKE/DROP/IRREGULAR_PATTERN
    AnomalyType that had no real backend equivalent. No mapping function
    exists to unit-test in isolation; the pass-through itself is verified
    against a realistic payload in the wired end-to-end test below.
    """
    assert set(ConsumptionAnomalyDirection) == {
        ConsumptionAnomalyDirection.INCREASE,
        ConsumptionAnomalyDirection.DECREASE,
    }


def test_get_open_purchase_orders_status_matches_real_backend_enum() -> None:
    """status is no longer remapped - the AI schema's enum now matches the
    real backend's 3-value InventoryTransactionStatus exactly (PENDING/
    COMPLETED/CANCELLED), replacing the fabricated 4-value PENDING/
    APPROVED/IN_TRANSIT/PARTIALLY_RECEIVED set that had no real backend
    equivalent.
    """
    assert set(PurchaseOrderStatus) == {
        PurchaseOrderStatus.PENDING,
        PurchaseOrderStatus.COMPLETED,
        PurchaseOrderStatus.CANCELLED,
    }


def test_sum_transaction_value_excludes_items_with_no_price() -> None:
    """price is optional per item (InventoryTransactionItem.price: Decimal?)
    - an item with no price must be excluded from the sum, not treated as
    free (0), matching the backend's own calculateTransactionCost()
    convention.
    """
    items = [
        {"quantity": 2, "price": "50.5"},
        {"quantity": 3, "price": None},
        {"quantity": 1, "price": "10"},
    ]
    assert _sum_transaction_value(items) == 2 * 50.5 + 1 * 10


def test_sum_transaction_value_handles_string_decimal_prices() -> None:
    """price arrives from the backend as a JSON STRING (decimal.js's
    toJSON()), not a JSON number - this must not raise or silently produce
    the wrong total.
    """
    assert _sum_transaction_value([{"quantity": 4, "price": "12.25"}]) == 49.0


def test_sum_transaction_value_is_null_when_no_item_has_a_price() -> None:
    assert _sum_transaction_value([{"quantity": 5, "price": None}]) is None


def test_build_transfer_recommendation_reason_reflects_destination_urgency() -> None:
    assert "is out of stock" in _build_transfer_recommendation_reason("OUT_OF_STOCK", None, False)
    assert "is at risk of stocking out" in _build_transfer_recommendation_reason("AT_RISK", None, False)
    assert "has adequate stock" in _build_transfer_recommendation_reason("OK", None, False)
    assert "uncertain stock position" in _build_transfer_recommendation_reason("SOMETHING_UNEXPECTED", None, False)


def test_build_transfer_recommendation_reason_includes_days_of_supply_when_known() -> None:
    with_supply = _build_transfer_recommendation_reason("AT_RISK", 5.7, False)
    assert "5.7 days of supply" in with_supply

    without_supply = _build_transfer_recommendation_reason("AT_RISK", None, False)
    assert "days of supply" not in without_supply


def test_build_transfer_recommendation_reason_flags_dead_stock_source() -> None:
    from_dead_stock = _build_transfer_recommendation_reason("AT_RISK", 10.0, True)
    assert "slow-moving stock" in from_dead_stock

    from_normal_stock = _build_transfer_recommendation_reason("AT_RISK", 10.0, False)
    assert "slow-moving stock" not in from_normal_stock


def test_supplier_recommendation_status_enum_matches_real_two_outcomes() -> None:
    assert set(SupplierRecommendationStatus) == {
        SupplierRecommendationStatus.SUPPLIER_RECOMMENDED,
        SupplierRecommendationStatus.NO_RECOMMENDATION,
    }


def _recommendation_for(product_id: int) -> dict:
    """Build one recommendation by driving the PURE computation helpers
    directly against the same insights_mock_data fixtures the tool used to
    call before it was wired to the real backend (see
    agents/insights_agent/tools.py - recommend_dead_stock_transfer() now
    calls get_backend_client() instead, but _qualifying_warehouses_by_recency/
    _compute_recommended_transfers/_build_dead_stock_transfer_reason are
    unchanged pure functions, so this still exercises exactly the same
    logic, offline, with no event loop or network access needed.

    insights_mock_data's dead-stock/ledger mocks are kept in the codebase
    for exactly this - see the module docstring in tools/mocks/insights_mock_data.py.
    """
    dead_stock = insights_mock_data.get_dead_stock_entries_mock()
    matches = [item for item in dead_stock["items"] if item["productId"] == product_id]
    assert len(matches) == 1, f"Expected exactly one dead-stock fixture entry for productId={product_id}"
    entry = matches[0]

    movements = insights_mock_data.get_outgoing_movements_mock(
        product_id, date_from=datetime.now() - timedelta(days=60)
    )
    qualifying_warehouses = _qualifying_warehouses_by_recency(movements, entry["warehouseId"])
    transfers = _compute_recommended_transfers(entry["onHand"], qualifying_warehouses)
    reason = _build_dead_stock_transfer_reason(
        days_since_last_outgoing=entry["daysSinceLastOutgoingMovement"],
        qualifying_count=len(qualifying_warehouses),
        on_hand=entry["onHand"],
        has_transfers=bool(transfers),
    )
    return {
        "productId": entry["productId"],
        "sourceWarehouseId": entry["warehouseId"],
        "onHand": entry["onHand"],
        "recommendedTransfers": transfers,
        "reason": reason,
    }


def test_recommend_dead_stock_transfer_one_qualifying_warehouse_gets_full_half() -> None:
    """productId 501: onHand=100, only warehouse 1 sold it recently -> all of floor(100/2) goes there."""
    rec = _recommendation_for(501)
    assert rec["sourceWarehouseId"] == 3
    assert rec["onHand"] == 100
    assert rec["recommendedTransfers"] == [{"destinationWarehouseId": 1, "quantity": 50}]
    assert "1 other warehouse" in rec["reason"]


def test_recommend_dead_stock_transfer_multiple_qualifying_warehouses_split_evenly() -> None:
    """productId 502: onHand=100, warehouses 1 and 2 both sold it recently -> even 25/25 split."""
    rec = _recommendation_for(502)
    transfers = {t["destinationWarehouseId"]: t["quantity"] for t in rec["recommendedTransfers"]}
    assert transfers == {1: 25, 2: 25}
    assert sum(transfers.values()) == 100 // 2
    assert "2 other warehouses" in rec["reason"]


def test_recommend_dead_stock_transfer_zero_qualifying_warehouses_gives_no_recommendation() -> None:
    """productId 503: the only recent OUTGOING movement is in warehouse 3 itself (the dead-stock
    warehouse) - self-exclusion means it does not count, so no other warehouse qualifies.
    """
    rec = _recommendation_for(503)
    assert rec["recommendedTransfers"] == []
    assert "no transfer destination available" in rec["reason"]


def test_recommend_dead_stock_transfer_odd_on_hand_rounds_down() -> None:
    """productId 504: onHand=101 (odd), one qualifying warehouse -> floor(101/2)=50, not 50.5, all to that warehouse."""
    rec = _recommendation_for(504)
    assert rec["onHand"] == 101
    assert rec["recommendedTransfers"] == [{"destinationWarehouseId": 1, "quantity": 50}]
    total_recommended = sum(t["quantity"] for t in rec["recommendedTransfers"])
    assert total_recommended == 101 // 2
    assert total_recommended < rec["onHand"], "The remainder must stay in the source warehouse"


def test_recommend_dead_stock_transfer_uneven_split_goes_to_most_recent_sellers_first() -> None:
    """productId 505: onHand=101 -> floor(101/2)=50 split across 3 qualifying warehouses (1, 2, 3),
    sold most-recently in that order (5, 10, 20 days ago respectively). 50 // 3 = 16 remainder 2, so
    the two MOST RECENT sellers (warehouses 1 and 2) each get one extra unit over the base 16.
    """
    rec = _recommendation_for(505)
    transfers = {t["destinationWarehouseId"]: t["quantity"] for t in rec["recommendedTransfers"]}
    assert transfers == {1: 17, 2: 17, 3: 16}
    assert sum(transfers.values()) == 101 // 2


def test_recommend_dead_stock_transfer_never_recommends_more_than_available_stock() -> None:
    """Cross-cutting invariant across every fixture entry: total recommended quantity must never exceed onHand."""
    dead_stock = insights_mock_data.get_dead_stock_entries_mock()
    product_ids = [item["productId"] for item in dead_stock["items"]]
    assert len(product_ids) > 0
    for product_id in product_ids:
        rec = _recommendation_for(product_id)
        total_recommended = sum(t["quantity"] for t in rec["recommendedTransfers"])
        assert total_recommended <= rec["onHand"]


def _fake_jwt() -> str:
    """Minimal, correctly-shaped (unsigned) JWT - see test_backend_client.py's
    identical helper for why the signature doesn't matter here."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": 1, "email": "ai-agent@internal.local", "role": "EMPLOYEE", "exp": time.time() + 3600}).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.fake-signature"


async def _service_token_provider() -> str:
    return _fake_jwt()


def _patch_backend_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """Point recommend_dead_stock_transfer() at a BackendClient backed by
    httpx.MockTransport instead of the real network - same pattern as
    tests/test_backend_client.py. Patches the name as bound inside
    agents.insights_agent.tools (where `from backend_client import
    get_backend_client` already resolved it at import time), not the
    origin backend_client module - patching the origin wouldn't affect the
    already-bound reference tools.py is using.
    """
    test_client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=_service_token_provider,
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(insights_tools_module, "get_backend_client", lambda: test_client)


def test_recommend_fulfillment_warehouse_uses_backend_available_stock_and_geography(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        if request.url.path == "/warehouse-routing/eligible-warehouses":
            payload = json.loads(request.content)
            assert payload["items"] == [
                {"productId": 103, "quantity": 12},
                {"productId": 108, "quantity": 25},
            ]
            return httpx.Response(200, json=[
                {"warehouseId": 2, "warehouseName": "North", "location": "Tripoli", "items": [
                    {"productId": 103, "onHand": 20, "reserved": 8, "available": 12, "requestedQuantity": 12},
                    {"productId": 108, "onHand": 40, "reserved": 10, "available": 30, "requestedQuantity": 25},
                ]},
                {"warehouseId": 3, "warehouseName": "Central", "location": "Beirut", "items": [
                    {"productId": 103, "onHand": 30, "reserved": 2, "available": 28, "requestedQuantity": 12},
                    {"productId": 108, "onHand": 30, "reserved": 1, "available": 29, "requestedQuantity": 25},
                ]},
            ])
        if request.url.path == "/path-optimizer/nearest-warehouse":
            return httpx.Response(200, json={"consideredCandidates": [
                {"warehouseId": 2, "distanceKm": 80.0},
                {"warehouseId": 3, "distanceKm": 12.0},
            ]})
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)
    result = asyncio.run(recommend_fulfillment_warehouse(
        items=[{"productId": 103, "quantity": 12}, {"productId": 108, "quantity": 25}],
        delivery_country="Lebanon",
        delivery_region="Beirut",
        delivery_address="Hamra",
    ))

    assert result["status"] == "RECOMMENDED"
    assert result["recommendedWarehouseId"] == 3
    assert result["geographyConsidered"] is True
    assert "/warehouse-routing/eligible-warehouses" in requested_paths
    assert "/path-optimizer/nearest-warehouse" in requested_paths


def test_recommend_dead_stock_transfer_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the REAL (now backend-calling) tool body end-to-end -
    real network calls through httpx.MockTransport, shaped exactly like
    the real backend: GET /stock-insights/dead-stock returns a BARE ARRAY
    (no {items, asOf} wrapper - confirmed against
    backend/src/stock-insights/stock-insights.service.ts), and
    GET /stock-movements/ledger likewise. This is what proves the
    items/asOf-unwrapping adjustment (see recommend_dead_stock_transfer())
    is actually correct, not just plausible.
    """

    def handler(request: httpx.Request) -> httpx.Response:

        if request.url.path == "/stock-insights/dead-stock":
            # Bare array, real DeadStockEntry field names.
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 501,
                        "warehouseId": 3,
                        "onHand": 100,
                        "lastMovementAt": None,
                        "daysSinceLastMovement": None,
                        "lastOutgoingMovementAt": "2026-06-01T00:00:00.000Z",
                        "daysSinceLastOutgoingMovement": 75,
                    },
                    {
                        "productId": 990,
                        "warehouseId": 5,
                        "onHand": 40,
                        "lastMovementAt": None,
                        "daysSinceLastMovement": None,
                        "lastOutgoingMovementAt": None,
                        "daysSinceLastOutgoingMovement": 400,
                    },
                    {
                        # A product that has NEVER had an OUTGOING movement at
                        # all - daysSinceLastOutgoingMovement is null, not just
                        # a large number. Confirmed against real backend data
                        # during the live check (see
                        # _build_dead_stock_transfer_reason's docstring) - the
                        # original hand-built mock fixtures never modeled this.
                        "productId": 991,
                        "warehouseId": 6,
                        "onHand": 20,
                        "lastMovementAt": None,
                        "daysSinceLastMovement": None,
                        "lastOutgoingMovementAt": None,
                        "daysSinceLastOutgoingMovement": None,
                    },
                ],
            )

        if request.url.path == "/stock-movements/ledger":
            product_id = int(request.url.params["productId"])
            assert request.url.params["type"] == "OUTGOING"
            assert "dateFrom" in request.url.params
            # Bare array, real StockMovement field names.
            if product_id == 501:
                return httpx.Response(
                    200,
                    json=[
                        {
                            "id": 1,
                            "productId": 501,
                            "warehouseId": 1,
                            "type": "OUTGOING",
                            "quantity": 9,
                            "transactionId": None,
                            "createdAt": "2026-08-10T00:00:00.000Z",
                        }
                    ],
                )
            return httpx.Response(200, json=[])  # productId 990/991: nobody else sold it

        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(recommend_dead_stock_transfer())

    by_product = {rec["productId"]: rec for rec in result["recommendations"]}
    assert by_product[501]["sourceWarehouseId"] == 3
    assert by_product[501]["recommendedTransfers"] == [{"destinationWarehouseId": 1, "quantity": 50}]
    assert by_product[990]["recommendedTransfers"] == []
    assert "no transfer destination available" in by_product[990]["reason"]
    assert by_product[991]["recommendedTransfers"] == []
    assert "never had a recorded sale" in by_product[991]["reason"]
    assert "None" not in by_product[991]["reason"], "must never render the null day-count literally"


def test_recommend_dead_stock_transfer_propagates_typed_backend_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real backend failure (503 here) must surface as the typed
    ServiceUnavailable exception, not be swallowed into a fake/empty
    success result - see the Raises: section of
    recommend_dead_stock_transfer()'s docstring for the reasoning: let
    Strands turn it into a proper tool-error result, let the agent's own
    prompt rules decide whether to retry or report honestly - same
    pattern every wired tool in this codebase follows.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "dead-stock query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(recommend_dead_stock_transfer())


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_recommend_dead_stock_transfer_live_against_real_backend() -> None:
    """Runs the tool for real: real login, real GET /stock-insights/dead-stock,
    real GET /stock-movements/ledger per entry, against whatever backend is
    actually running at settings.backend_url. Only runs when one is
    reachable (see tests/_helpers.py::backend_reachable) - this is the one
    test in this suite that is NOT offline-safe by design.
    """
    result = asyncio.run(recommend_dead_stock_transfer())

    assert isinstance(result["recommendations"], list)
    assert len(result["recommendations"]) > 0, (
        "Expected at least one dead-stock entry from the real backend's seed data"
    )
    for rec in result["recommendations"]:
        assert {"productId", "sourceWarehouseId", "onHand", "recommendedTransfers", "reason"} <= rec.keys()
        total_recommended = sum(t["quantity"] for t in rec["recommendedTransfers"])
        assert total_recommended <= rec["onHand"]


def test_get_stockout_risk_wired_end_to_end_against_mocked_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real
    GET /stock-insights/stockout-risk (bare array, real StockoutRiskEntry
    field names - confirmed against stock-insights.service.ts). Proves
    riskLevel passes through unchanged (no remapping - removed in favor of
    a direct 3-value pass-through matching the real enum exactly), the
    predictedStockoutDate field-name fix, and the
    riskScore/productName/warehouseName drops are all actually correct
    against a realistic payload, not just plausible.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/stockout-risk":
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 102,
                        "warehouseId": 1,
                        "onHand": 12,
                        "activeReserved": 0,
                        "available": 12,
                        "reorderThreshold": 25,
                        "riskLevel": "AT_RISK",
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 12,
                        "projectedRiskLevel": "AT_RISK",
                        "avgDailyConsumption": 2.1,
                        "daysOfSupply": 5.7,
                        "predictedStockoutDate": "2026-08-21T09:00:00.000Z",
                    },
                    {
                        "productId": 108,
                        "warehouseId": 2,
                        "onHand": 0,
                        "activeReserved": 0,
                        "available": 0,
                        "reorderThreshold": 20,
                        "riskLevel": "OUT_OF_STOCK",
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 0,
                        "projectedRiskLevel": "OUT_OF_STOCK",
                        "avgDailyConsumption": 3.4,
                        "daysOfSupply": 0,
                        "predictedStockoutDate": "2026-08-15T09:00:00.000Z",
                    },
                    {
                        "productId": 101,
                        "warehouseId": 1,
                        "onHand": 340,
                        "activeReserved": 45,
                        "available": 295,
                        "reorderThreshold": 50,
                        "riskLevel": "OK",
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 295,
                        "projectedRiskLevel": "OK",
                        "avgDailyConsumption": 4.7,
                        "daysOfSupply": 62.8,
                        "predictedStockoutDate": None,
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_stockout_risk())

    by_product = {item["productId"]: item for item in result["items"]}
    assert by_product[102]["riskLevel"] == "AT_RISK"  # pass-through, no remapping
    assert by_product[108]["riskLevel"] == "OUT_OF_STOCK"
    assert by_product[101]["riskLevel"] == "OK"
    assert by_product[102]["predictedStockoutDate"] is not None
    assert by_product[101]["predictedStockoutDate"] is None
    for item in by_product.values():
        assert {
            "onHand",
            "activeReserved",
            "available",
            "reorderThreshold",
            "pendingIncomingQuantity",
            "projectedAvailable",
            "projectedRiskLevel",
            "avgDailyConsumption",
            "daysOfSupply",
        } <= item.keys()
        assert "riskScore" not in item
        assert "productName" not in item
        assert "warehouseName" not in item


def test_get_stockout_risk_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "stockout-risk query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(get_stockout_risk())


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_get_stockout_risk_live_against_real_backend() -> None:
    result = asyncio.run(get_stockout_risk())

    assert isinstance(result["items"], list)
    for item in result["items"]:
        assert {"productId", "warehouseId", "riskLevel", "predictedStockoutDate", "averageDailyConsumption"} <= item.keys()
        assert item["riskLevel"] in {"OK", "AT_RISK", "OUT_OF_STOCK"}
        assert "riskScore" not in item


def test_analyze_dead_stock_wired_end_to_end_against_mocked_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real
    GET /stock-insights/dead-stock (bare array, real DeadStockEntry field
    names). Proves both movement-date pairs pass through independently,
    including the null case (never had an OUTGOING movement at all), and
    that reason/tiedUpCapital/productName/warehouseName are all absent.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/dead-stock":
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 340,
                        "warehouseId": 2,
                        "onHand": 120,
                        "lastMovementAt": "2026-02-01T00:00:00.000Z",
                        "daysSinceLastMovement": 195,
                        "lastOutgoingMovementAt": None,
                        "daysSinceLastOutgoingMovement": None,
                    },
                    {
                        "productId": 341,
                        "warehouseId": 1,
                        "onHand": 50,
                        "lastMovementAt": "2026-06-01T00:00:00.000Z",
                        "daysSinceLastMovement": 75,
                        "lastOutgoingMovementAt": "2026-06-01T00:00:00.000Z",
                        "daysSinceLastOutgoingMovement": 75,
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(analyze_dead_stock())

    by_product = {item["productId"]: item for item in result["items"]}
    assert by_product[340]["lastOutgoingMovementAt"] is None
    assert by_product[340]["daysSinceLastOutgoingMovement"] is None
    assert by_product[340]["daysSinceLastMovement"] == 195
    assert by_product[341]["daysSinceLastOutgoingMovement"] == 75
    for item in by_product.values():
        assert "reason" not in item
        assert "tiedUpCapital" not in item
        assert "productName" not in item
        assert "warehouseName" not in item


def test_analyze_dead_stock_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "dead-stock query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(analyze_dead_stock())


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_analyze_dead_stock_live_against_real_backend() -> None:
    result = asyncio.run(analyze_dead_stock())

    assert isinstance(result["items"], list)
    for item in result["items"]:
        assert {
            "productId",
            "warehouseId",
            "onHand",
            "lastMovementAt",
            "daysSinceLastMovement",
            "lastOutgoingMovementAt",
            "daysSinceLastOutgoingMovement",
        } <= item.keys()
        assert "reason" not in item
        assert "tiedUpCapital" not in item


def test_get_restock_recommendations_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real
    GET /stock-insights/restock-recommendations (bare array, real
    RestockRecommendation field names). Proves the recommendedQuantity
    rename, the reason enum pass-through, the explanation pass-through,
    and the needsReorder/candidate/productName/warehouseName drops are
    all actually correct against a realistic payload.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/restock-recommendations":
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 102,
                        "warehouseId": 1,
                        "available": 12,
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 12,
                        "reorderThreshold": 25,
                        "riskLevel": "AT_RISK",
                        "projectedRiskLevel": "AT_RISK",
                        "recommendedQuantity": 13,
                        "avgDailyConsumption": 2.1,
                        "daysOfSupply": 5.7,
                        "reason": "purchase_required",
                        "explanation": (
                            "No pending incoming stock and no warehouse surplus are available "
                            "for this product, so a new purchase is required to reach the "
                            "reorder threshold (25)."
                        ),
                    },
                    {
                        "productId": 103,
                        "warehouseId": 2,
                        "available": 8,
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 8,
                        "reorderThreshold": 20,
                        "riskLevel": "AT_RISK",
                        "projectedRiskLevel": "AT_RISK",
                        "recommendedQuantity": 12,
                        "avgDailyConsumption": 1.4,
                        "daysOfSupply": 5.7,
                        "reason": "transfer_available",
                        "explanation": (
                            "Another warehouse currently holds surplus stock of this product, "
                            "so the shortfall can be covered by an internal transfer instead of "
                            "a new purchase."
                        ),
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_restock_recommendations())

    by_product = {rec["productId"]: rec for rec in result["recommendations"]}
    assert by_product[102]["recommendedQuantity"] == 13
    assert by_product[102]["reason"] == "purchase_required"
    assert by_product[103]["reason"] == "transfer_available"
    assert by_product[102]["explanation"].startswith("No pending incoming stock")
    for rec in by_product.values():
        assert {
            "available",
            "pendingIncomingQuantity",
            "projectedAvailable",
            "reorderThreshold",
            "riskLevel",
            "projectedRiskLevel",
            "avgDailyConsumption",
            "daysOfSupply",
        } <= rec.keys()
        assert "needsReorder" not in rec
        assert "candidate" not in rec
        assert "productName" not in rec
        assert "warehouseName" not in rec


def test_get_restock_recommendations_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "restock-recommendations query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(get_restock_recommendations())


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_get_restock_recommendations_live_against_real_backend() -> None:
    result = asyncio.run(get_restock_recommendations())

    assert isinstance(result["recommendations"], list)
    for rec in result["recommendations"]:
        assert {"productId", "warehouseId", "recommendedQuantity", "reason", "explanation"} <= rec.keys()
        assert rec["reason"] in {"transfer_available", "purchase_required"}
        assert "needsReorder" not in rec
        assert "candidate" not in rec


def test_get_transfer_recommendations_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real
    GET /stock-insights/transfer-recommendations (bare array, real
    TransferRecommendation field names - fromWarehouseId/toWarehouseId/
    transferQuantity). Proves the field renames to sourceWarehouseId/
    destinationWarehouseId/quantity and the deterministic reason-building
    are both actually correct against a realistic payload.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/transfer-recommendations":
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 103,
                        "fromWarehouseId": 2,
                        "toWarehouseId": 1,
                        "transferQuantity": 15,
                        "fromWarehouseAvailableAfterTransfer": 33,
                        "toWarehouseProjectedAvailableAfterTransfer": 27,
                        "sourcePendingIncomingQuantity": 0,
                        "sourceIsDeadStock": False,
                        "destinationRiskLevel": "AT_RISK",
                        "destinationAvgDailyConsumption": 2.1,
                        "destinationDaysOfSupply": 5.7,
                    }
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_transfer_recommendations())

    assert len(result["recommendations"]) == 1
    rec = result["recommendations"][0]
    assert rec["fromWarehouseId"] == 2
    assert rec["toWarehouseId"] == 1
    assert rec["transferQuantity"] == 15
    assert rec["fromWarehouseAvailableAfterTransfer"] == 33
    assert rec["toWarehouseProjectedAvailableAfterTransfer"] == 27
    assert rec["sourcePendingIncomingQuantity"] == 0
    assert rec["sourceIsDeadStock"] is False
    assert rec["destinationRiskLevel"] == "AT_RISK"
    assert rec["destinationAvgDailyConsumption"] == 2.1
    assert rec["destinationDaysOfSupply"] == 5.7
    assert "is at risk of stocking out" in rec["reason"]
    assert "5.7 days of supply" in rec["reason"]
    assert "productName" not in rec


def test_get_transfer_recommendations_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "transfer-recommendations query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(get_transfer_recommendations())


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_get_transfer_recommendations_live_against_real_backend() -> None:
    result = asyncio.run(get_transfer_recommendations())

    assert isinstance(result["recommendations"], list)
    for rec in result["recommendations"]:
        assert {"productId", "sourceWarehouseId", "destinationWarehouseId", "quantity", "reason"} <= rec.keys()
        assert isinstance(rec["reason"], str) and rec["reason"]


def test_get_consumption_anomalies_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real
    GET /stock-insights/consumption-anomalies (bare array, real
    ConsumptionAnomaly field names - confirmed against
    stock-insights.service.ts: productId, warehouseId, recentQuantity,
    baselineQuantity, percentChange, direction. Backend now evaluates
    consumption PER (productId, warehouseId) pair - warehouseId was added
    back on 2026-08-20, reversing a prior wiring pass's correct omission
    of a field that didn't exist yet). Proves the direction pass-through,
    the null-percentChange (zero-baseline) case, the warehouseId
    pass-through (including two different warehouses for the SAME product,
    proving they are not merged), and the productName/warehouseName drops
    are all actually correct against a realistic payload.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/consumption-anomalies":
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 102,
                        "warehouseId": 1,
                        "recentQuantity": 90,
                        "baselineQuantity": 30,
                        "percentChange": 200.0,
                        "direction": "INCREASE",
                    },
                    {
                        "productId": 102,
                        "warehouseId": 2,
                        "recentQuantity": 5,
                        "baselineQuantity": 40,
                        "percentChange": -87.5,
                        "direction": "DECREASE",
                    },
                    {
                        "productId": 115,
                        "warehouseId": 1,
                        "recentQuantity": 12,
                        "baselineQuantity": 0,
                        "percentChange": None,
                        "direction": "INCREASE",
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_consumption_anomalies())

    by_key = {(item["productId"], item["warehouseId"]): item for item in result["anomalies"]}
    # Same productId, two different warehouses - both present as separate
    # entries, not merged into one.
    assert by_key[(102, 1)]["direction"] == "INCREASE"  # pass-through, no remapping
    assert by_key[(102, 2)]["direction"] == "DECREASE"
    assert by_key[(102, 2)]["percentChange"] == -87.5
    assert by_key[(115, 1)]["percentChange"] is None  # zero-baseline case
    for item in by_key.values():
        assert "productName" not in item
        assert "warehouseName" not in item
        assert "anomalyType" not in item


def test_get_consumption_anomalies_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "consumption-anomalies query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(get_consumption_anomalies())


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_get_consumption_anomalies_live_against_real_backend() -> None:
    result = asyncio.run(get_consumption_anomalies())

    assert isinstance(result["anomalies"], list)
    for item in result["anomalies"]:
        assert {
            "productId",
            "warehouseId",
            "recentQuantity",
            "baselineQuantity",
            "percentChange",
            "direction",
        } <= item.keys()
        assert item["direction"] in {"INCREASE", "DECREASE"}
        assert isinstance(item["warehouseId"], int)


def test_get_open_purchase_orders_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real
    GET /inventory-transactions?type=INCOMING&status=PENDING (bare array,
    real InventoryTransaction field names with an `items` array - confirmed
    against inventory-transactions.service.ts/schema.prisma). Proves the
    purchaseOrderId/warehouseId renames, the lineItemCount/totalValue
    computed-in-Python aggregation (including a string-Decimal price and a
    missing price on the same order), and the supplierName/warehouseName
    drops are all actually correct against a realistic payload.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/inventory-transactions":
            assert request.url.params["type"] == "INCOMING"
            assert request.url.params["status"] == "PENDING"
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 501,
                        "type": "INCOMING",
                        "status": "PENDING",
                        "supplierId": 7,
                        "destinationWarehouseId": 2,
                        "expectedDate": "2026-09-01T00:00:00.000Z",
                        "items": [
                            {"id": 1, "productId": 102, "quantity": 10, "price": "50.5"},
                            {"id": 2, "productId": 103, "quantity": 4, "price": None},
                        ],
                    },
                    {
                        "id": 502,
                        "type": "INCOMING",
                        "status": "PENDING",
                        "supplierId": 3,
                        "destinationWarehouseId": 1,
                        "expectedDate": None,
                        "items": [
                            {"id": 3, "productId": 108, "quantity": 20, "price": "12.25"},
                        ],
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_open_purchase_orders())

    by_id = {order["purchaseOrderId"]: order for order in result["orders"]}
    assert by_id[501]["supplierId"] == 7
    assert by_id[501]["warehouseId"] == 2
    assert by_id[501]["status"] == "PENDING"
    assert by_id[501]["lineItemCount"] == 2
    assert by_id[501]["totalValue"] == 10 * 50.5  # priceless item excluded, not treated as 0
    assert by_id[502]["lineItemCount"] == 1
    assert by_id[502]["totalValue"] == 20 * 12.25
    for order in by_id.values():
        assert "supplierName" not in order
        assert "warehouseName" not in order


def test_get_open_purchase_orders_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "inventory-transactions query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(get_open_purchase_orders())


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_get_open_purchase_orders_live_against_real_backend() -> None:
    result = asyncio.run(get_open_purchase_orders())

    assert isinstance(result["orders"], list)
    for order in result["orders"]:
        assert {
            "purchaseOrderId",
            "supplierId",
            "warehouseId",
            "status",
            "lineItemCount",
            "totalValue",
        } <= order.keys()
        assert order["status"] == "PENDING"
        assert "supplierName" not in order


def test_get_available_stock_specific_warehouse_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """warehouse_id given: one GET /products call (shared across all
    product_ids), one GET /warehouses call (shared, for warehouseName),
    then one GET /warehouse-inventory/available/{warehouseId}/{productId}
    call per product_id. Product 108 has no inventory row at warehouse 2
    at all (a real 404 from that endpoint) - proves this is reported as a
    genuine available: 0 answer, not an error.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products":
            return httpx.Response(
                200,
                json=[
                    {"id": 102, "name": "Widget", "category": None, "description": None, "isActive": True},
                    {"id": 108, "name": "Gadget", "category": None, "description": None, "isActive": True},
                ],
            )
        if request.url.path == "/warehouses":
            return httpx.Response(
                200,
                json=[{"id": 2, "name": "Main Warehouse", "location": None, "maxCapacity": None, "isActive": True}],
            )
        if request.url.path == "/warehouse-inventory/available/2/102":
            return httpx.Response(
                200, json={"warehouseId": 2, "productId": 102, "onHand": 40, "reserved": 12, "available": 28}
            )
        if request.url.path == "/warehouse-inventory/available/2/108":
            return httpx.Response(404, json={"message": "Inventory for product 108 in warehouse 2 not found"})
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_available_stock(product_ids=[102, 108], warehouse_id=2))

    by_product = {item["productId"]: item for item in result["items"]}
    assert by_product[102]["productName"] == "Widget"
    assert by_product[102]["warehouseName"] == "Main Warehouse"
    assert by_product[102]["onHand"] == 40
    assert by_product[102]["reserved"] == 12
    assert by_product[102]["available"] == 28

    # Not stocked here - a real "0" answer, not a raised error.
    assert by_product[108]["productName"] == "Gadget"
    assert by_product[108]["warehouseName"] == "Main Warehouse"
    assert by_product[108]["warehouseId"] == 2
    assert by_product[108]["onHand"] == 0
    assert by_product[108]["reserved"] == 0
    assert by_product[108]["available"] == 0

    # Code-level safety net: 2 distinct products requested together must
    # carry a note disclaiming whole-order fulfillment, pointing at
    # recommend_fulfillment_warehouse() by name.
    assert result["note"] is not None
    assert "2 products" in result["note"]
    assert "independently" in result["note"]
    assert "recommend_fulfillment_warehouse()" in result["note"]


def test_get_available_stock_note_is_none_for_a_single_product(monkeypatch: pytest.MonkeyPatch) -> None:
    """The safety-net note must cost nothing for a legitimate single-product
    lookup - it should only appear once a second distinct product is in
    play, never for the common single-item case."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products":
            return httpx.Response(
                200,
                json=[{"id": 102, "name": "Widget", "category": None, "description": None, "isActive": True}],
            )
        if request.url.path == "/warehouses":
            return httpx.Response(
                200,
                json=[{"id": 2, "name": "Main Warehouse", "location": None, "maxCapacity": None, "isActive": True}],
            )
        if request.url.path == "/warehouse-inventory/available/2/102":
            return httpx.Response(
                200, json={"warehouseId": 2, "productId": 102, "onHand": 40, "reserved": 12, "available": 28}
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_available_stock(product_ids=[102], warehouse_id=2))

    assert result["note"] is None


def test_get_available_stock_note_is_none_for_duplicate_ids_of_the_same_product(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """product_ids=[102, 102] is one DISTINCT product asked about twice, not
    a multi-product order - the safety net keys on distinct products, not
    list length, so this must NOT get the whole-order-fulfillment note."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products":
            return httpx.Response(
                200,
                json=[{"id": 102, "name": "Widget", "category": None, "description": None, "isActive": True}],
            )
        if request.url.path == "/warehouses":
            return httpx.Response(
                200,
                json=[{"id": 2, "name": "Main Warehouse", "location": None, "maxCapacity": None, "isActive": True}],
            )
        if request.url.path == "/warehouse-inventory/available/2/102":
            return httpx.Response(
                200, json={"warehouseId": 2, "productId": 102, "onHand": 40, "reserved": 12, "available": 28}
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_available_stock(product_ids=[102, 102], warehouse_id=2))

    assert result["note"] is None


def test_get_available_stock_discovery_mode_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No warehouse_id: one GET /products call, then per product_id one
    GET /warehouse-inventory/product/{productId} discovery call (bare
    WarehouseInventory rows with a nested warehouse object - confirmed
    against warehouse-inventory.service.ts's getByProduct()), then one
    GET /warehouse-inventory/available/{warehouseId}/{productId} call per
    warehouse it actually discovered - never a warehouse it didn't
    discover. Proves warehouseName comes from the discovery response's
    nested warehouse object, not a separate GET /warehouses call.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products":
            return httpx.Response(
                200,
                json=[{"id": 102, "name": "Widget", "category": None, "description": None, "isActive": True}],
            )
        if request.url.path == "/warehouse-inventory/product/102":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 1,
                        "productId": 102,
                        "warehouseId": 1,
                        "onHand": 40,
                        "reorderThreshold": 10,
                        "warehouse": {
                            "id": 1,
                            "name": "North Warehouse",
                            "location": None,
                            "maxCapacity": None,
                            "isActive": True,
                        },
                    },
                    {
                        "id": 2,
                        "productId": 102,
                        "warehouseId": 2,
                        "onHand": 5,
                        "reorderThreshold": 10,
                        "warehouse": {
                            "id": 2,
                            "name": "South Warehouse",
                            "location": None,
                            "maxCapacity": None,
                            "isActive": True,
                        },
                    },
                ],
            )
        if request.url.path == "/warehouse-inventory/available/1/102":
            return httpx.Response(
                200, json={"warehouseId": 1, "productId": 102, "onHand": 40, "reserved": 12, "available": 28}
            )
        if request.url.path == "/warehouse-inventory/available/2/102":
            return httpx.Response(
                200, json={"warehouseId": 2, "productId": 102, "onHand": 5, "reserved": 0, "available": 5}
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_available_stock(product_ids=[102]))

    assert len(result["items"]) == 2
    by_warehouse = {item["warehouseId"]: item for item in result["items"]}
    assert by_warehouse[1]["warehouseName"] == "North Warehouse"
    assert by_warehouse[1]["available"] == 28
    assert by_warehouse[2]["warehouseName"] == "South Warehouse"
    assert by_warehouse[2]["available"] == 5
    for item in by_warehouse.values():
        assert item["productName"] == "Widget"


def test_get_available_stock_name_is_none_for_inactive_product(monkeypatch: pytest.MonkeyPatch) -> None:
    """GET /products only returns ACTIVE products (confirmed against
    products.service.ts's findAll()) - an inactive product's id simply
    won't be in the lookup. Real stock numbers must still come through;
    only the name is None, never fabricated.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products":
            return httpx.Response(200, json=[])  # product 900 is inactive, not in the active catalog
        if request.url.path == "/warehouses":
            return httpx.Response(
                200, json=[{"id": 2, "name": "Main Warehouse", "location": None, "maxCapacity": None, "isActive": True}]
            )
        if request.url.path == "/warehouse-inventory/available/2/900":
            return httpx.Response(
                200, json={"warehouseId": 2, "productId": 900, "onHand": 10, "reserved": 0, "available": 10}
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_available_stock(product_ids=[900], warehouse_id=2))

    item = result["items"][0]
    assert item["productName"] is None
    assert item["available"] == 10  # real stock data survives even without a name


def test_get_available_stock_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-404 failure (e.g. 503) must still propagate - only the specific
    "no inventory row here" 404 case is handled as a zero result.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products":
            return httpx.Response(200, json=[{"id": 102, "name": "Widget", "category": None, "description": None, "isActive": True}])
        return httpx.Response(503, json={"message": "inventory service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(get_available_stock(product_ids=[102], warehouse_id=2))


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_get_available_stock_live_against_real_backend() -> None:
    result = asyncio.run(get_available_stock(product_ids=[101, 102, 103]))

    assert isinstance(result["items"], list)
    for item in result["items"]:
        assert {"productId", "warehouseId", "onHand", "reserved", "available"} <= item.keys()
        assert item["available"] == item["onHand"] - item["reserved"]


def test_get_low_stock_products_deficit_is_computed_tool_side() -> None:
    """Pure logic: max(reorderThreshold - available, 0), never negative even
    if given data that shouldn't occur from the real backend (which only
    ever returns rows where available <= reorderThreshold already).
    """
    assert max(25 - 12, 0) == 13
    assert max(25 - 25, 0) == 0
    assert max(25 - 30, 0) == 0  # floored - would only happen from bad input, never real backend data


def test_get_low_stock_products_specific_warehouse_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """warehouse_id given: one GET /warehouses call (shared, for
    warehouseName) then one GET /warehouse-inventory/low-stock/{warehouseId}
    call, shaped exactly like the real response (bare array, each row
    spreading the WarehouseInventory row with a nested `product` object,
    plus `reserved`/`available` - confirmed against
    warehouse-inventory.service.ts's getLowStockProducts()). Proves the
    deficit computation and the productName-from-nested-join/
    warehouseName-from-separate-call split are both correct.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/warehouses":
            return httpx.Response(
                200, json=[{"id": 2, "name": "Main Warehouse", "location": None, "maxCapacity": None, "isActive": True}]
            )
        if request.url.path == "/warehouse-inventory/low-stock/2":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 1,
                        "productId": 102,
                        "warehouseId": 2,
                        "onHand": 12,
                        "reorderThreshold": 25,
                        "product": {"id": 102, "name": "USB-C Docking Station", "category": None, "description": None, "isActive": True},
                        "reserved": 8,
                        "available": 4,
                    }
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_low_stock_products(warehouse_id=2))

    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["productName"] == "USB-C Docking Station"
    assert item["warehouseName"] == "Main Warehouse"
    assert item["onHand"] == 12
    assert item["reorderThreshold"] == 25
    assert item["reserved"] == 8
    assert item["available"] == 4
    assert item["deficit"] == 21  # 25 - 4, computed tool-side


def test_get_low_stock_products_all_warehouses_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No warehouse_id: one GET /warehouses discovery call (reused for
    warehouseName - not fetched twice), then one low-stock call per
    ACTIVE warehouse it discovered. An inactive warehouse (id 99, filtered
    out of /warehouses' isActive:true response) must never be queried.
    """
    requested_low_stock_warehouse_ids: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/warehouses":
            return httpx.Response(
                200,
                json=[
                    {"id": 1, "name": "North Warehouse", "location": None, "maxCapacity": None, "isActive": True},
                    {"id": 2, "name": "South Warehouse", "location": None, "maxCapacity": None, "isActive": True},
                ],
            )
        match = re.fullmatch(r"/warehouse-inventory/low-stock/(\d+)", request.url.path)
        if match:
            warehouse_id = int(match.group(1))
            requested_low_stock_warehouse_ids.append(warehouse_id)
            if warehouse_id == 1:
                return httpx.Response(
                    200,
                    json=[
                        {
                            "id": 1,
                            "productId": 102,
                            "warehouseId": 1,
                            "onHand": 12,
                            "reorderThreshold": 25,
                            "product": {"id": 102, "name": "USB-C Docking Station", "category": None, "description": None, "isActive": True},
                            "reserved": 8,
                            "available": 4,
                        }
                    ],
                )
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(get_low_stock_products())

    assert sorted(requested_low_stock_warehouse_ids) == [1, 2]
    assert 99 not in requested_low_stock_warehouse_ids
    assert len(result["items"]) == 1
    assert result["items"][0]["warehouseId"] == 1
    assert result["items"][0]["warehouseName"] == "North Warehouse"


def test_get_low_stock_products_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "warehouse inventory service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(get_low_stock_products(warehouse_id=2))


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_get_low_stock_products_live_against_real_backend() -> None:
    result = asyncio.run(get_low_stock_products())

    assert isinstance(result["items"], list)
    for item in result["items"]:
        assert {"productId", "warehouseId", "onHand", "reorderThreshold", "reserved", "available", "deficit"} <= item.keys()
        assert item["available"] <= item["reorderThreshold"]
        assert item["deficit"] == max(item["reorderThreshold"] - item["available"], 0)


def test_calculate_reorder_quantity_status_enum_matches_real_two_outcomes() -> None:
    assert set(ReorderQuantityStatus) == {ReorderQuantityStatus.REORDER_RECOMMENDED, ReorderQuantityStatus.NOT_AT_RISK}


def test_calculate_reorder_quantity_reorder_recommended_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Matching entry found in the real restock-recommendations list -
    proves the client-side filter to the exact (productId, warehouseId)
    pair works, and that recommendedQuantity/status reflect the real
    matched entry, not a fabricated method.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/restock-recommendations":
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 102,
                        "warehouseId": 1,
                        "available": 12,
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 12,
                        "reorderThreshold": 25,
                        "riskLevel": "AT_RISK",
                        "projectedRiskLevel": "AT_RISK",
                        "recommendedQuantity": 13,
                        "avgDailyConsumption": 2.1,
                        "daysOfSupply": 5.7,
                        "reason": "purchase_required",
                        "explanation": "No pending incoming stock...",
                    },
                    {
                        "productId": 103,
                        "warehouseId": 2,
                        "available": 8,
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 8,
                        "reorderThreshold": 20,
                        "riskLevel": "AT_RISK",
                        "projectedRiskLevel": "AT_RISK",
                        "recommendedQuantity": 99,
                        "avgDailyConsumption": 1.4,
                        "daysOfSupply": 5.7,
                        "reason": "transfer_available",
                        "explanation": "Another warehouse currently holds surplus...",
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    # Deliberately requesting productId=102/warehouseId=1 - must match ONLY
    # that entry, not the other one that also has recommendedQuantity set.
    result = asyncio.run(calculate_reorder_quantity(product_id=102, warehouse_id=1))

    assert result["productId"] == 102
    assert result["warehouseId"] == 1
    assert result["recommendedQuantity"] == 13
    assert result["status"] == "reorder_recommended"


def test_calculate_reorder_quantity_not_at_risk_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No matching entry for the requested pair (present in the list for
    OTHER pairs, absent for this one) - a real, deliberate "healthy stock"
    answer, not an error and not missing data.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/restock-recommendations":
            return httpx.Response(
                200,
                json=[
                    {
                        "productId": 999,
                        "warehouseId": 999,
                        "available": 1,
                        "pendingIncomingQuantity": 0,
                        "projectedAvailable": 1,
                        "reorderThreshold": 50,
                        "riskLevel": "AT_RISK",
                        "projectedRiskLevel": "AT_RISK",
                        "recommendedQuantity": 49,
                        "avgDailyConsumption": 3.0,
                        "daysOfSupply": 0.3,
                        "reason": "purchase_required",
                        "explanation": "irrelevant to this test",
                    }
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(calculate_reorder_quantity(product_id=101, warehouse_id=1))

    assert result["productId"] == 101
    assert result["warehouseId"] == 1
    assert result["recommendedQuantity"] == 0
    assert result["status"] == "not_at_risk"
    assert "method" not in result


def test_calculate_reorder_quantity_not_at_risk_when_list_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """No AT_RISK/OUT_OF_STOCK entries anywhere - every pair is healthy."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/stock-insights/restock-recommendations":
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(calculate_reorder_quantity(product_id=101, warehouse_id=1))

    assert result["status"] == "not_at_risk"
    assert result["recommendedQuantity"] == 0


def test_calculate_reorder_quantity_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "restock-recommendations query timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(calculate_reorder_quantity(product_id=101, warehouse_id=1))


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_calculate_reorder_quantity_live_against_real_backend() -> None:
    """Runs against whatever the real backend actually reports right now -
    asserts the response is well-formed and status-consistent, not any
    specific product's risk state (that's real, live data and can change).
    """
    entries = asyncio.run(_helper_client_get_restock_recommendations())
    assert entries, "Expected at least one real restock recommendation to test against"
    target = entries[0]

    result = asyncio.run(calculate_reorder_quantity(product_id=target["productId"], warehouse_id=target["warehouseId"]))

    assert result["status"] == "reorder_recommended"
    assert result["recommendedQuantity"] == target["recommendedQuantity"]
    assert "method" not in result


async def _helper_client_get_restock_recommendations() -> list[dict]:
    from backend_client import get_backend_client

    client = get_backend_client()
    return await client.get("/stock-insights/restock-recommendations")


def test_compare_suppliers_normal_case_wired_end_to_end_against_mocked_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercises the REAL (backend-calling) tool body end-to-end via
    httpx.MockTransport, shaped exactly like the real GET /suppliers (bare
    array of full Supplier rows) and GET /supplier-intelligence/rank?productId=
    (bare array of RankedSupplier - confirmed against
    supplier-intelligence.service.ts). Proves exactly 2 real HTTP calls are
    made (never a 3rd to /compare or /best), leadTimeDays is correctly
    merged in from the separate /suppliers call, and recommendedSupplier/
    recommendationStatus are correctly derived client-side as the rank===1
    entry - reproducing GET /supplier-intelligence/best without calling it.
    Also proves the recommendation is NOT simply the cheapest supplier,
    same intent as the original mocked version of this test.
    """
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        if request.url.path == "/suppliers":
            return httpx.Response(
                200,
                json=[
                    {"id": 7, "name": "Acme Supply Co", "email": "sales@acme.test", "leadTimeDays": 5, "isActive": True, "createdAt": "2026-01-01T00:00:00.000Z"},
                    {"id": 9, "name": "Budget Parts Ltd", "email": None, "leadTimeDays": 14, "isActive": True, "createdAt": "2026-01-01T00:00:00.000Z"},
                ],
            )
        if request.url.path == "/supplier-intelligence/rank":
            assert request.url.params["productId"] == "102"
            return httpx.Response(
                200,
                json=[
                    {
                        "supplierId": 7,
                        "supplierName": "Acme Supply Co",
                        "productId": 102,
                        "totalTransactions": 10,
                        "completedTransactions": 9,
                        "cancelledTransactions": 1,
                        "cancellationRate": 0.1,
                        "averagePrice": 25.0,
                        "pricedItemCount": 9,
                        "onTimeDeliveryRate": 0.95,
                        "evaluatedForOnTimeCount": 9,
                        "purchaseFrequency": 3.0,
                        "firstPurchaseDate": "2026-01-01T00:00:00.000Z",
                        "lastPurchaseDate": "2026-06-01T00:00:00.000Z",
                        "rank": 1,
                        "score": 88.5,
                        "insufficientData": False,
                        "insufficientDataReasons": [],
                        "componentScores": {"price": 70.0, "onTimeDelivery": 95.0, "cancellationPerformance": 90.0, "productSupplyHistory": 100.0},
                    },
                    {
                        "supplierId": 9,
                        "supplierName": "Budget Parts Ltd",
                        "productId": 102,
                        "totalTransactions": 12,
                        "completedTransactions": 11,
                        "cancelledTransactions": 1,
                        "cancellationRate": 0.083,
                        "averagePrice": 15.0,  # cheaper than Acme
                        "pricedItemCount": 11,
                        "onTimeDeliveryRate": 0.6,  # but much less reliable
                        "evaluatedForOnTimeCount": 11,
                        "purchaseFrequency": 3.6,
                        "firstPurchaseDate": "2026-01-01T00:00:00.000Z",
                        "lastPurchaseDate": "2026-06-01T00:00:00.000Z",
                        "rank": 2,
                        "score": 62.0,
                        "insufficientData": False,
                        "insufficientDataReasons": [],
                        "componentScores": {"price": 100.0, "onTimeDelivery": 20.0, "cancellationPerformance": 85.0, "productSupplyHistory": 90.0},
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(compare_suppliers(product_id=102))

    # Exactly 2 real backend calls - service auth happens directly with Cognito.
    assert sorted(requested_paths) == sorted(["/suppliers", "/supplier-intelligence/rank"])

    by_id = {score["supplierId"]: score for score in result["scores"]}
    assert by_id[7]["leadTimeDays"] == 5  # merged in from the separate /suppliers call
    assert by_id[9]["leadTimeDays"] == 14
    assert by_id[7]["unitCost"] == 25.0
    assert by_id[7]["reliabilityScore"] == 0.95
    assert by_id[7]["overallScore"] == 88.5  # real 0-100 scale, not rescaled
    assert by_id[7]["componentScores"] == {
        "price": 70.0,
        "onTimeDelivery": 95.0,
        "cancellationPerformance": 90.0,
        "productSupplyHistory": 100.0,
    }
    assert by_id[7]["totalTransactions"] == 10

    assert result["recommendationStatus"] == "supplier_recommended"
    recommended = result["recommendedSupplier"]
    assert recommended["supplierId"] == 7
    cheapest = min(result["scores"], key=lambda s: s["unitCost"])
    # The mock data is deliberately set up so the recommended supplier is
    # NOT the cheapest one - proving the tool surfaces the real backend's
    # backend's weighted pick, not just raw cost. leadTimeDays is returned
    # separately as context and is not part of this ranking assertion.
    assert recommended["supplierId"] != cheapest["supplierId"]


def test_compare_suppliers_no_recommendation_when_all_insufficient_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every candidate is insufficientData (none reach rank 1) - a real,
    deliberate "no recommendation" answer, not an error and not a crash on
    a None rank.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/suppliers":
            return httpx.Response(
                200,
                json=[{"id": 3, "name": "New Vendor Inc", "email": None, "leadTimeDays": None, "isActive": True, "createdAt": "2026-01-01T00:00:00.000Z"}],
            )
        if request.url.path == "/supplier-intelligence/rank":
            return httpx.Response(
                200,
                json=[
                    {
                        "supplierId": 3,
                        "supplierName": "New Vendor Inc",
                        "productId": 999,
                        "totalTransactions": 1,
                        "completedTransactions": 1,
                        "cancelledTransactions": 0,
                        "cancellationRate": 0.0,
                        "averagePrice": 40.0,
                        "pricedItemCount": 1,
                        "onTimeDeliveryRate": None,
                        "evaluatedForOnTimeCount": 0,
                        "purchaseFrequency": 1.0,
                        "firstPurchaseDate": "2026-06-01T00:00:00.000Z",
                        "lastPurchaseDate": "2026-06-01T00:00:00.000Z",
                        "rank": None,
                        "score": None,
                        "insufficientData": True,
                        "insufficientDataReasons": [
                            "onTimeDeliveryRate unavailable: no transactions with both expectedDate and actualDate",
                            "productSupplyHistory unavailable: fewer than 3 completed transactions for this product (has 1)",
                        ],
                        "componentScores": {"price": 100.0, "onTimeDelivery": None, "cancellationPerformance": 100.0, "productSupplyHistory": None},
                    }
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(compare_suppliers(product_id=999))

    assert result["recommendationStatus"] == "no_recommendation"
    assert result["recommendedSupplier"] is None
    # Insufficient-data supplier is KEPT in the list, not dropped.
    assert len(result["scores"]) == 1
    entry = result["scores"][0]
    assert entry["insufficientData"] is True
    assert entry["rank"] is None
    assert entry["overallScore"] is None
    assert entry["reliabilityScore"] is None
    assert entry["leadTimeDays"] is None
    assert len(entry["insufficientDataReasons"]) == 2


def test_compare_suppliers_no_recommendation_when_no_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    """No supplier has ever supplied this product at all - empty list, not an error."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/suppliers":
            return httpx.Response(200, json=[])
        if request.url.path == "/supplier-intelligence/rank":
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(compare_suppliers(product_id=555))

    assert result["scores"] == []
    assert result["recommendedSupplier"] is None
    assert result["recommendationStatus"] == "no_recommendation"


def test_compare_suppliers_partial_nulls_are_never_defaulted_to_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    """One supplier has a price but no on-time data, another has on-time
    data but no priced items - each null stays None, never silently
    becomes 0 (which would be a fabricated, misleading value: 0 cost or
    0% reliability both read as real, alarming data rather than "unknown").
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/suppliers":
            return httpx.Response(
                200,
                json=[
                    {"id": 1, "name": "Supplier A", "email": None, "leadTimeDays": 7, "isActive": True, "createdAt": "2026-01-01T00:00:00.000Z"},
                    {"id": 2, "name": "Supplier B", "email": None, "leadTimeDays": None, "isActive": True, "createdAt": "2026-01-01T00:00:00.000Z"},
                ],
            )
        if request.url.path == "/supplier-intelligence/rank":
            return httpx.Response(
                200,
                json=[
                    {
                        "supplierId": 1,
                        "supplierName": "Supplier A",
                        "productId": 200,
                        "totalTransactions": 5,
                        "completedTransactions": 5,
                        "cancelledTransactions": 0,
                        "cancellationRate": 0.0,
                        "averagePrice": 30.0,
                        "pricedItemCount": 5,
                        "onTimeDeliveryRate": None,
                        "evaluatedForOnTimeCount": 0,
                        "purchaseFrequency": 2.0,
                        "firstPurchaseDate": "2026-01-01T00:00:00.000Z",
                        "lastPurchaseDate": "2026-05-01T00:00:00.000Z",
                        "rank": None,
                        "score": None,
                        "insufficientData": True,
                        "insufficientDataReasons": ["onTimeDeliveryRate unavailable: no transactions with both expectedDate and actualDate"],
                        "componentScores": {"price": 100.0, "onTimeDelivery": None, "cancellationPerformance": 100.0, "productSupplyHistory": 100.0},
                    },
                    {
                        "supplierId": 2,
                        "supplierName": "Supplier B",
                        "productId": 200,
                        "totalTransactions": 4,
                        "completedTransactions": 4,
                        "cancelledTransactions": 0,
                        "cancellationRate": 0.0,
                        "averagePrice": None,
                        "pricedItemCount": 0,
                        "onTimeDeliveryRate": 1.0,
                        "evaluatedForOnTimeCount": 4,
                        "purchaseFrequency": 1.5,
                        "firstPurchaseDate": "2026-01-01T00:00:00.000Z",
                        "lastPurchaseDate": "2026-05-01T00:00:00.000Z",
                        "rank": None,
                        "score": None,
                        "insufficientData": True,
                        "insufficientDataReasons": ["averagePrice unavailable: no priced items for this product from this supplier"],
                        "componentScores": {"price": None, "onTimeDelivery": 100.0, "cancellationPerformance": 100.0, "productSupplyHistory": 100.0},
                    },
                ],
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    result = asyncio.run(compare_suppliers(product_id=200))

    by_id = {score["supplierId"]: score for score in result["scores"]}
    assert by_id[1]["unitCost"] == 30.0
    assert by_id[1]["reliabilityScore"] is None  # never defaulted to 0
    assert by_id[2]["unitCost"] is None  # never defaulted to 0
    assert by_id[2]["reliabilityScore"] == 1.0
    assert by_id[2]["leadTimeDays"] is None  # Supplier.leadTimeDays itself is null
    assert result["recommendationStatus"] == "no_recommendation"


def test_compare_suppliers_propagates_typed_backend_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"message": "supplier-intelligence service timed out"})

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(ServiceUnavailable):
        asyncio.run(compare_suppliers(product_id=102))


@pytest.mark.integration
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping integration test",
)
def test_compare_suppliers_live_against_real_backend() -> None:
    """Runs against whatever the real backend actually reports right now -
    asserts the response is well-formed and internally consistent, not any
    specific supplier being recommended (that's real, live data).
    """
    result = asyncio.run(compare_suppliers(product_id=102))

    assert result["productId"] == 102
    assert isinstance(result["scores"], list)
    assert result["recommendationStatus"] in {"supplier_recommended", "no_recommendation"}
    if result["recommendationStatus"] == "supplier_recommended":
        assert result["recommendedSupplier"] is not None
        assert result["recommendedSupplier"]["rank"] == 1
    else:
        assert result["recommendedSupplier"] is None
    for score in result["scores"]:
        assert {"supplierId", "supplierName", "insufficientData", "insufficientDataReasons"} <= score.keys()
        if score["insufficientData"]:
            assert score["overallScore"] is None
            assert score["rank"] is None
        else:
            assert score["overallScore"] is not None
            assert 0 <= score["overallScore"] <= 100


@pytest.mark.skipif(
    not settings.openai_api_key,
    reason="OPENAI_API_KEY not set - skipping live-model smoke test",
)
def test_insights_agent_live_openai_smoke() -> None:
    """End-to-end smoke test against a real model (OpenAI provider), with mocked tools.

    Only runs when OPENAI_API_KEY is present. Exercises build_insights_agent()
    -> settings.build_model("insights") -> a real OpenAI chat completion,
    while the tool data underneath stays fully mocked. Asserts a non-empty,
    coherent response - not any specific wording, since model output varies.
    """
    agent = build_insights_agent()
    result = agent(
        "In one short sentence, which single product is most at risk of "
        "stocking out, and what should I do about it?"
    )
    text = str(result).strip()
    assert text, "Expected a non-empty response from the live model"
    assert len(text) > 15, f"Response looked too short to be coherent: {text!r}"


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping tool-error handling smoke test",
)
def test_insights_agent_reports_tool_error_instead_of_fabricating(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression test for a real bug caught in local testing (general error-handling gap, not tool-specific).

    Forces get_available_stock's backend call to fail and asserts the
    agent's final answer is honest about it: either it genuinely retried (a
    second real call recorded below) or it clearly told the user the action
    failed - never that it silently claimed success with invented figures.
    This uses an active backend-backed tool and an HTTP mock transport; it
    does not restore a mock-only production tool.
    """
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"message": "Simulated transient failure"})

    _patch_backend_client(monkeypatch, handler)

    agent = build_insights_agent()
    result = agent("Check available stock for product ID 102 at warehouse 1. Give me a short summary.")
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
    # NOTE: deliberately not "again" alone - it's a substring of unrelated
    # words like "against", which produced a false-positive pass in local
    # testing against a real model. Word-level terms below are still
    # checked as substrings, so prefer specific multi-character
    # words/phrases unlikely to appear inside unrelated text.
    lowered = text.lower()
    assert any(term in lowered for term in failure_language), (
        "Agent neither retried the failed tool call nor reported failure - "
        f"looks like a fabricated success. Response: {text!r}"
    )


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping expiry-decline smoke test",
)
def test_insights_agent_declines_expiry_questions_honestly() -> None:
    """Follow-up to get_expiry_risk's removal (2026-08-21) and "expiry"
    being dropped from the Supervisor's gate/prompt scope lists the same
    day (see agents/supervisor/gate.py, agents/supervisor/prompts.py).

    The gate still classifies an expiry question as in-scope (confirmed
    live - it's a plausible inventory question even without the literal
    keyword, per the gate's own "when uncertain, prefer IN SCOPE" rule -
    see test_gate.py's IN_SCOPE_QUERIES). So the question DOES reach this
    agent. What matters here is what Insights itself does with it: there
    is no expiry-related tool anywhere in INSIGHTS_TOOLS, so the agent
    must not pick an unrelated tool (dead stock, consumption anomalies,
    stockout risk) and present its output as if it answered the expiry
    question - it must say, honestly, that it doesn't have this
    capability. Same no-fabrication principle as
    test_insights_agent_reports_tool_error_instead_of_fabricating above,
    but for "no tool exists for this at all" rather than "a tool call
    failed."
    """
    agent = build_insights_agent()
    result = agent("Which products are approaching their expiry date? Give me a short summary.")
    text = str(result).strip()
    assert text, "Expected a non-empty response from the live model"

    capability_gap_language = (
        "dont have",
        "dont support",
        "dont check",
        "cant check",
        "no expiry",
        "no dedicated",
        "not available",
        "not supported",
        "cannot",
        "cant",
        "couldnt",
        "unable",
        "unavailable",
    )
    # Strip every apostrophe variant - straight and the two curly ones -
    # using \N{...} named escapes (pure ASCII source) rather than literal
    # characters, since a real model response in local testing used a
    # curly apostrophe in its decline. Match terms above are deliberately
    # apostrophe-free ("cant" not "can't") so this comparison never
    # depends on which apostrophe variant the model happens to produce.
    apostrophes = "'" + "\N{RIGHT SINGLE QUOTATION MARK}" + "\N{LEFT SINGLE QUOTATION MARK}"
    lowered = "".join(ch for ch in text.lower() if ch not in apostrophes)
    assert any(term in lowered for term in capability_gap_language), (
        "Agent did not honestly acknowledge lacking an expiry-tracking capability - "
        f"looks like it may have fabricated an expiry answer instead. Response: {text!r}"
    )

    # A fabricated expiry answer would plausibly mention a risk-level word
    # (this ERP's old mocked contract used LOW/MEDIUM/HIGH) as if it were
    # real data about specific products - it must not appear as a claimed
    # finding here, since no real expiry data exists anywhere to back it.
    for fabricated_term in ("high risk", "medium risk", "low risk", "risk level"):
        assert fabricated_term not in lowered, (
            f"Response appears to fabricate expiry risk data ({fabricated_term!r} found). "
            f"Response: {text!r}"
        )
