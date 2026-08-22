"""Supervisor wiring test.

Does NOT test routing logic (that's a TODO in agents/supervisor/agent.py -
see its module docstring). Only asserts that both specialist agents import
cleanly as tools and register on the Supervisor without error - i.e. the
Agents-as-Tools wiring compiles and constructs, proving the architecture is
exactly 3 agents (Supervisor + Insights + Document) with no missing or
extra pieces.

Also covers settings.build_model("supervisor") across all three supported
MODEL_PROVIDER values (openai/ollama/bedrock). None of these need real
credentials - every strands Model class only validates
credentials/connectivity on the first real call, never at construction -
so this exercises provider selection under all three without requiring
whichever provider isn't currently active in the environment.
"""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import replace

import httpx
import pytest

from agents.document_agent import tools as document_tools_module
from agents.document_agent.agent import document_agent_tool
from agents.insights_agent import tools as insights_tools_module
from agents.insights_agent.agent import insights_agent_tool
from agents.supervisor.agent import SUPERVISOR_TOOLS, build_supervisor_agent
from backend_client import BackendClient
from config.settings import settings
from tests._helpers import live_model_configured

_MATCHED_DATA_RE = re.compile(r"\[MATCHED_DATA\]\s*(\{.*?\})\s*\[/MATCHED_DATA\]", re.DOTALL)
# Placeholder text for the flagship scenario's prompt only - none of the
# document_agent tools this scenario can reach (match_products,
# choose_fulfillment_warehouse) validate document_id against any mock
# document set any more (ALL document_agent tools are wired to the real
# backend as of 2026-08-22 - see the flagship test's own docstring below
# for the fuller picture), so any fictional-looking id works here. This
# used to be tools/mocks/document_mock_data.py's KNOWN_ORDER_DOCUMENT_ID
# constant, now inlined directly since that file (100% dead) was deleted.
_ORDER_PROMPT_PLACEHOLDER_DOCUMENT_ID = "doc_ord_2026_0815_001"

# Same fixed catalog test_insights_agent.py's mock data used to encode
# before get_available_stock was wired to the real backend - kept here so
# this scenario (27in Monitor / Mechanical Keyboard) still produces the
# same real shortage: Keyboard (108, available 4) is short of the 25
# requested; Monitor (103, available 48) is not.
_FLAGSHIP_STOCK_CATALOG = {
    101: {"productName": "Wireless Mouse", "warehouseId": 1, "warehouseName": "London Central", "onHand": 340, "reserved": 45},
    102: {"productName": "USB-C Docking Station", "warehouseId": 1, "warehouseName": "London Central", "onHand": 12, "reserved": 8},
    103: {"productName": "27in Monitor", "warehouseId": 2, "warehouseName": "Manchester North", "onHand": 58, "reserved": 10},
    108: {"productName": "Mechanical Keyboard", "warehouseId": 2, "warehouseName": "Manchester North", "onHand": 6, "reserved": 2},
}


def _fake_jwt() -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": 1, "email": "ai-agent@internal.local", "role": "EMPLOYEE", "exp": time.time() + 3600}).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.fake-signature"


def test_specialist_tools_import_cleanly() -> None:
    assert callable(insights_agent_tool)
    assert callable(document_agent_tool)


def test_supervisor_tools_list_has_exactly_two_specialists() -> None:
    """Locked architecture: exactly 2 specialists wrapped as tools, no more, no less."""
    assert len(SUPERVISOR_TOOLS) == 2
    assert insights_agent_tool in SUPERVISOR_TOOLS
    assert document_agent_tool in SUPERVISOR_TOOLS


def test_supervisor_agent_builds_and_registers_both_specialist_tools() -> None:
    agent = build_supervisor_agent()
    assert agent.name == "supervisor"

    registered_tool_names = set(agent.tool_names)
    assert "insights_agent_tool" in registered_tool_names
    assert "document_agent_tool" in registered_tool_names


@pytest.mark.parametrize(
    ("provider", "expected_model_class"),
    [
        ("openai", "OpenAIModel"),
        ("ollama", "OllamaModel"),
        ("bedrock", "BedrockModel"),
    ],
)
def test_build_model_supports_supervisor_under_every_provider(
    provider: str, expected_model_class: str
) -> None:
    """settings.build_model("supervisor") must work for every MODEL_PROVIDER
    without requiring credentials for whichever provider isn't in use.

    Uses dataclasses.replace() to test each provider against an isolated
    copy of the real settings object, rather than mutating the environment
    or the shared settings singleton (whose field defaults are resolved
    once at import time - see config/settings.py).
    """
    provider_settings = replace(settings, model_provider=provider)
    model = provider_settings.build_model("supervisor")
    assert type(model).__name__ == expected_model_class


def test_supervisor_still_builds_standalone_under_the_active_provider() -> None:
    """Sanity check that build_supervisor_agent() itself (not just
    build_model()) works end to end under whatever MODEL_PROVIDER the test
    environment is actually running with - no credentials required, since
    construction never makes a real model call.
    """
    agent = build_supervisor_agent()
    assert type(agent.model).__name__ in {"OpenAIModel", "OllamaModel", "BedrockModel"}


def _tool_use_and_result_by_name(messages: list[dict]) -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    """Group a conversation's toolUse inputs and toolResult payloads by tool name.

    Returns (tool_uses_by_name, tool_results_by_name), each mapping a tool
    name to the list of toolUse["input"] dicts / parsed toolResult JSON
    payloads for every call to that tool in the conversation.
    """
    tool_names_by_id: dict[str, str] = {}
    tool_uses_by_name: dict[str, list[dict]] = {}
    tool_results_by_name: dict[str, list[dict]] = {}

    for message in messages:
        for block in message.get("content", []):
            tool_use = block.get("toolUse")
            if tool_use:
                name = tool_use.get("name")
                tool_use_id = tool_use.get("toolUseId")
                if tool_use_id:
                    tool_names_by_id[tool_use_id] = name
                tool_uses_by_name.setdefault(name, []).append(tool_use.get("input") or {})

    for message in messages:
        for block in message.get("content", []):
            tool_result = block.get("toolResult")
            if not tool_result:
                continue
            name = tool_names_by_id.get(tool_result.get("toolUseId"))
            if name is None:
                continue
            for content_item in tool_result.get("content") or []:
                text = content_item.get("text")
                if text:
                    tool_results_by_name.setdefault(name, []).append(text)

    return tool_uses_by_name, tool_results_by_name


def test_flagship_scenario_threads_matched_product_ids_from_document_to_insights(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Full order-document-to-fulfillment-shortage scenario, through the real Supervisor.

    Regression test for the Supervisor's ID-threading gap: document_agent_tool
    and insights_agent_tool each worked correctly in isolation, but the
    Supervisor wasn't reliably carrying document_agent_tool's matched
    product_ids (and requested quantities) into its insights_agent_tool
    call - it would ask a generic stock question instead of checking the
    exact ordered items, and so missed a real shortage.

    Asserts, from the Supervisor's own conversation:
      1. document_agent_tool ran and its result contains a [MATCHED_DATA]
         block with the expected product_ids (103, 108).
      2. insights_agent_tool was subsequently called with those same
         product_ids explicitly present in its query text (not a generic
         question with no IDs).
      3. The underlying get_available_stock tool actually executed real
         backend HTTP calls covering product_ids 103 and 108 - proof the
         threading reached all the way down to a real, non-generic tool
         call, not just that the Supervisor's text happened to mention the
         numbers.
      4. The final response reflects the real shortage (Mechanical Keyboard
         short of the requested quantity), not generic restock language.

    get_available_stock was wired to the real backend on 2026-08-20 (was
    previously mocked via insights_mock_data.get_available_stock_mock,
    which this test used to monkeypatch directly). It's now async and
    calls get_backend_client(), so this test patches that instead - same
    httpx.MockTransport pattern test_insights_agent.py uses - serving a
    fixed catalog (_FLAGSHIP_STOCK_CATALOG) that mirrors the old mock data
    exactly, so the real shortage this scenario depends on is unchanged.

    match_products was ALSO wired to the real backend on 2026-08-22
    (rapidfuzz against GET /products - see the wiring investigation), so
    this test now patches agents.document_agent.tools.get_backend_client
    too (document_tools_module), pointed at the SAME mock transport/catalog
    - previously unnecessary, since match_products was a pure mock with no
    backend call at all. The catalog's product names ("27in Monitor",
    "Mechanical Keyboard") are exact matches against themselves, so
    classification is deterministic (rapidfuzz WRatio 100.0, well past the
    MATCHED threshold) regardless of the real thresholds' tuning.

    choose_fulfillment_warehouse remains fully mocked (still validates
    document_id against tools/mocks/document_mock_data.py's
    _MOCK_DOCUMENTS and recognizes KNOWN_ORDER_DOCUMENT_ID) - unaffected
    by match_products/find_supplier's rewiring, since those two no longer
    look at document_id at all. This is why the prompt below still uses
    KNOWN_ORDER_DOCUMENT_ID and still explicitly tells the model NOT to
    call extract_document (wired to the real backend on 2026-08-22 -
    GET /document-review/:id, which round-trips a real numeric id and
    would 404 against this fictional one): match_products no longer cares
    what document_id it's given, but choose_fulfillment_warehouse still
    does, so the scenario still needs a document_id both tools accept -
    KNOWN_ORDER_DOCUMENT_ID satisfies both (match_products ignores it,
    choose_fulfillment_warehouse recognizes it). This does not weaken the
    regression this test guards: the MATCHED_DATA threading it verifies is
    produced by match_products/choose_fulfillment_warehouse, not by
    extract_document.

    Only needs a live MODEL (not a live backend) - all backend calls,
    from both agents, are intercepted by the mock transport.

    Fix history (2026-08-22, this test was skipped and re-evaluated
    several times - see git history for the earlier skip reasons if
    useful context is needed): the prompt below did not originally state
    requested quantities (12 monitors, 25 keyboards) - that used to come
    for free from extract_document_mock's fixture data before
    extract_document was wired to the real backend and this test had to
    stop relying on it. Without quantities, the model correctly declined
    to conclude fulfillability, or guessed a placeholder - neither
    satisfies assertion 4 below, which requires a real quantity-based
    shortage conclusion. Fixed by stating the quantities explicitly in
    the prompt (test-data fix only, no prompt file touched for this part).
    Separately, agents/supervisor/prompts.py's tool-boundary description
    was fixed to state explicitly that document_agent_tool (not
    insights_agent_tool) owns product/supplier-name matching and
    fulfillment-warehouse selection even when the extraction step itself
    is skipped (data already given inline) - previously the Supervisor
    would sometimes route the whole "match items, choose a warehouse,
    check fulfillment" request straight to insights_agent_tool, which has
    no matching capability and would call get_available_stock with
    self-invented product_ids as a result. Both fixes verified with two
    separate rounds of 5 live runs each (5/5 passing on the final round)
    before un-skipping permanently.
    """
    recorded_product_ids: set[int] = set()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": _fake_jwt()})
        if request.url.path == "/products":
            return httpx.Response(
                200,
                json=[
                    {"id": product_id, "name": info["productName"], "category": None, "description": None, "isActive": True}
                    for product_id, info in _FLAGSHIP_STOCK_CATALOG.items()
                ],
            )
        if request.url.path == "/warehouses":
            # Only reached if the model happens to pass a warehouse_id
            # itself - this scenario gives it no warehouse context, so
            # discovery mode (no warehouse_id) is the expected path, but
            # this keeps the mock robust either way.
            seen_warehouses = {(info["warehouseId"], info["warehouseName"]) for info in _FLAGSHIP_STOCK_CATALOG.values()}
            return httpx.Response(
                200,
                json=[
                    {"id": warehouse_id, "name": name, "location": None, "maxCapacity": None, "isActive": True}
                    for warehouse_id, name in seen_warehouses
                ],
            )
        match = re.fullmatch(r"/warehouse-inventory/product/(\d+)", request.url.path)
        if match:
            product_id = int(match.group(1))
            recorded_product_ids.add(product_id)
            info = _FLAGSHIP_STOCK_CATALOG.get(product_id)
            if info is None:
                return httpx.Response(200, json=[])
            return httpx.Response(
                200,
                json=[
                    {
                        "id": product_id,
                        "productId": product_id,
                        "warehouseId": info["warehouseId"],
                        "onHand": info["onHand"],
                        "reorderThreshold": 5,
                        "warehouse": {
                            "id": info["warehouseId"],
                            "name": info["warehouseName"],
                            "location": None,
                            "maxCapacity": None,
                            "isActive": True,
                        },
                    }
                ],
            )
        match = re.fullmatch(r"/warehouse-inventory/available/(\d+)/(\d+)", request.url.path)
        if match:
            warehouse_id, product_id = int(match.group(1)), int(match.group(2))
            recorded_product_ids.add(product_id)
            info = _FLAGSHIP_STOCK_CATALOG.get(product_id)
            if info is None or info["warehouseId"] != warehouse_id:
                return httpx.Response(404, json={"message": f"Inventory for product {product_id} in warehouse {warehouse_id} not found"})
            return httpx.Response(
                200,
                json={
                    "warehouseId": warehouse_id,
                    "productId": product_id,
                    "onHand": info["onHand"],
                    "reserved": info["reserved"],
                    "available": info["onHand"] - info["reserved"],
                },
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    test_client = BackendClient(
        base_url="http://backend.test",
        email="ai-agent@internal.local",
        password="irrelevant-mocked",
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(insights_tools_module, "get_backend_client", lambda: test_client)
    monkeypatch.setattr(document_tools_module, "get_backend_client", lambda: test_client)

    agent = build_supervisor_agent()
    result = agent(
        f"The order document with document_id={_ORDER_PROMPT_PLACEHOLDER_DOCUMENT_ID} has ALREADY been "
        "extracted - do not call extract_document for it. Here is its already-extracted order "
        "data: customer Bluewater Retail Group, ordering 12 units of a 27in Monitor and 25 "
        "units of a Mechanical Keyboard. Match these line items against our product catalog, "
        "choose a fulfillment warehouse, and tell me whether we can actually fulfill it right "
        "now - compare available stock against the requested quantity for each item."
    )
    final_text = str(result)

    tool_uses_by_name, tool_results_by_name = _tool_use_and_result_by_name(agent.messages)

    # 1. document_agent_tool ran and returned a [MATCHED_DATA] block with the
    # expected product_ids.
    document_results = tool_results_by_name.get("document_agent_tool")
    assert document_results, "Expected document_agent_tool to have been called at least once"

    matched_data = None
    for text in document_results:
        match = _MATCHED_DATA_RE.search(text)
        if match:
            matched_data = json.loads(match.group(1))
            break
    assert matched_data is not None, (
        f"Expected a [MATCHED_DATA] block in document_agent_tool's result. Got: {document_results!r}"
    )
    assert set(matched_data["product_ids"]) >= {103, 108}, (
        f"Expected product_ids to include 103 and 108, got {matched_data['product_ids']!r}"
    )

    # 2. insights_agent_tool was called afterward with those IDs explicitly
    # present in the query text sent to it (not a generic question).
    insights_calls = tool_uses_by_name.get("insights_agent_tool")
    assert insights_calls, "Expected insights_agent_tool to have been called at least once"
    assert any(
        "103" in call.get("query", "") and "108" in call.get("query", "") for call in insights_calls
    ), f"Expected an insights_agent_tool call whose query explicitly mentions IDs 103 and 108, got: {insights_calls!r}"

    # 3. The real get_available_stock tool executed genuine backend calls
    # covering both items - not a None/generic call.
    assert {103, 108} <= recorded_product_ids, (
        f"Expected real get_available_stock backend calls covering product_ids 103 and 108, "
        f"got: {recorded_product_ids!r}"
    )

    # 4. The final answer reflects the real shortage, not generic restock
    # language - Mechanical Keyboard (108, 4 available) is short of the 25
    # requested; the 27in Monitor (103, 48 available) is not.
    lowered = final_text.lower()
    assert "mechanical keyboard" in lowered, f"Expected the shortfall item to be named. Response: {final_text!r}"
    shortage_language = ("short", "not enough", "cannot", "can't", "insufficient", "unable to fulfill")
    assert any(term in lowered for term in shortage_language), (
        f"Expected the response to state the order can't be fully fulfilled. Response: {final_text!r}"
    )
