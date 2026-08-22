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
import inspect
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
from agents.supervisor import agent as supervisor_agent_module
from agents.supervisor.prompts import SUPERVISOR_SYSTEM_PROMPT
from backend_client import BackendClient
from config.settings import settings
from tests._helpers import live_model_configured

_MATCHED_DATA_RE = re.compile(r"\[MATCHED_DATA\]\s*(\{.*?\})\s*\[/MATCHED_DATA\]", re.DOTALL)
_FLAGSHIP_DOCUMENT_ID = "801"


def _fake_jwt() -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": 1, "email": "ai-agent@internal.local", "role": "EMPLOYEE", "exp": time.time() + 3600}).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.fake-signature"


async def _service_token_provider() -> str:
    return _fake_jwt()


def test_specialist_tools_import_cleanly() -> None:
    assert callable(insights_agent_tool)
    assert callable(document_agent_tool)


def test_supervisor_tools_list_has_exactly_two_specialists() -> None:
    """Locked architecture: exactly 2 specialists wrapped as tools, no more, no less."""
    assert len(SUPERVISOR_TOOLS) == 2
    assert insights_agent_tool in SUPERVISOR_TOOLS
    assert document_agent_tool in SUPERVISOR_TOOLS


def test_supervisor_does_not_expose_sql_rag_or_runtime_mocks() -> None:
    tool_names = {getattr(tool, "__name__", "") for tool in SUPERVISOR_TOOLS}
    assert "query_database" not in tool_names
    assert "tools.mocks" not in inspect.getsource(supervisor_agent_module)


def test_supervisor_prompt_has_explicit_specialist_routing_boundaries() -> None:
    prompt = " ".join(SUPERVISOR_SYSTEM_PROMPT.split())

    assert "Route pure inventory and analytics requests to insights_agent_tool" in prompt
    assert "Route pure document/review requests to document_agent_tool" in prompt
    assert "document_agent_tool first and insights_agent_tool second" in prompt
    assert "Never call query_database directly" in prompt
    assert "must never write or execute SQL directly" in prompt
    assert "Never ask Insights to guess IDs from product names" in prompt
    assert "Insights can evaluate full-order AVAILABLE stock and recommend a fulfillment warehouse" in prompt
    assert "NO ability to choose a fulfillment warehouse" not in prompt
    assert 'NEVER ask it to "choose a warehouse"' not in prompt
    assert "The Supervisor never executes a write action" in prompt
    assert "unless the specialist returned explicit confirmation" in prompt


def test_supervisor_prompt_excludes_removed_tools_and_fourth_agent() -> None:
    for removed_tool_name in (
        "draft_purchase_order",
        "calculate_reorder_quantity",
        "recommend_dead_stock_transfer",
    ):
        assert removed_tool_name not in SUPERVISOR_SYSTEM_PROMPT
    assert "Control Tower is batch narration, not an agent" in SUPERVISOR_SYSTEM_PROMPT


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


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping Supervisor routing integration test",
)
def test_flagship_scenario_threads_matched_product_ids_from_document_to_insights(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercise the current Document-resolver to Insights-eligibility flow.

    The live model must route Document first, preserve exact resolved IDs and
    quantities in [MATCHED_DATA], then ask Insights to run full-order AVAILABLE
    stock eligibility. All backend calls are intercepted by MockTransport.
    """
    eligibility_payloads: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/document-review/801":
            return httpx.Response(
                200,
                json={
                    "id": 801,
                    "status": "PENDING_REVIEW",
                    "transactionType": "OUTGOING",
                    "partyName": "Bluewater Retail Group",
                    "extractedItems": [
                        {"product": "27in Monitor", "quantity": 12},
                        {"product": "Mechanical Keyboard", "quantity": 25},
                    ],
                },
            )
        if request.url.path == "/document-review/resolve-product":
            product_name = request.url.params["query"]
            resolved = {
                "27in Monitor": {"productId": 103, "name": "27in Monitor", "score": 1},
                "Mechanical Keyboard": {
                    "productId": 108,
                    "name": "Mechanical Keyboard",
                    "score": 1,
                },
            }
            return httpx.Response(200, json=[resolved[product_name]])
        if request.url.path == "/warehouse-routing/eligible-warehouses":
            payload = json.loads(request.content)
            eligibility_payloads.append(payload)
            assert payload["items"] == [
                {"productId": 103, "quantity": 12},
                {"productId": 108, "quantity": 25},
            ]
            return httpx.Response(200, json=[])
        if request.url.path == "/path-optimizer/nearest-warehouse":
            raise AssertionError("nearest warehouse must not run when no warehouse is eligible")
        raise AssertionError(f"unexpected path {request.url.path}")

    test_client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=_service_token_provider,
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(insights_tools_module, "get_backend_client", lambda: test_client)
    monkeypatch.setattr(document_tools_module, "get_backend_client", lambda: test_client)

    agent = build_supervisor_agent()
    result = agent(
        f"The order document with document_id={_FLAGSHIP_DOCUMENT_ID} has ALREADY been "
        "extracted upstream. Here is its already-extracted order "
        "data: customer Bluewater Retail Group, ordering 12 units of a 27in Monitor and 25 "
        "units of a Mechanical Keyboard. Match these line items against our product catalog, "
        "and tell me whether we can actually fulfill it right "
        "now - compare available stock against the requested quantity for each item."
    )
    final_text = str(result)

    tool_uses_by_name, tool_results_by_name = _tool_use_and_result_by_name(agent.messages)

    top_level_sequence = [
        block["toolUse"]["name"]
        for message in agent.messages
        for block in message.get("content", [])
        if "toolUse" in block
    ]
    assert top_level_sequence.index("document_agent_tool") < top_level_sequence.index(
        "insights_agent_tool"
    )

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
    assert {item["product_id"]: item["quantity"] for item in matched_data["requested_quantities"]} == {
        103: 12,
        108: 25,
    }

    # 2. insights_agent_tool was called afterward with those IDs explicitly
    # present in the query text sent to it (not a generic question).
    insights_calls = tool_uses_by_name.get("insights_agent_tool")
    assert insights_calls, "Expected insights_agent_tool to have been called at least once"
    assert any(
        all(value in call.get("query", "") for value in ("103", "108", "12", "25"))
        for call in insights_calls
    ), (
        "Expected an insights_agent_tool call whose query explicitly mentions IDs 103 and 108 "
        f"and requested quantities 12 and 25, got: {insights_calls!r}"
    )

    # 3. Insights called the current full-order AVAILABLE-stock eligibility
    # endpoint with both exact product/quantity pairs.
    assert eligibility_payloads

    # 4. The final answer reflects the real shortage, not generic restock
    # language: the backend returned no warehouse eligible for the full order.
    lowered = final_text.lower()
    shortage_language = ("cannot", "can't", "not currently", "no eligible", "unable to fulfill")
    assert any(term in lowered for term in shortage_language), (
        f"Expected the response to state the order can't be fully fulfilled. Response: {final_text!r}"
    )
