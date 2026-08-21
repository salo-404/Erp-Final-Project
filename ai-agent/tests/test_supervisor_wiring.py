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

import json
import re
from dataclasses import replace

import pytest

from agents.document_agent.agent import document_agent_tool
from agents.insights_agent.agent import insights_agent_tool
from agents.supervisor.agent import SUPERVISOR_TOOLS, build_supervisor_agent
from agents.supervisor.prompts import SUPERVISOR_SYSTEM_PROMPT
from config.settings import settings
from tests._helpers import live_model_configured
from tools.mocks import insights_mock_data
from tools.mocks.document_mock_data import KNOWN_ORDER_DOCUMENT_ID

_MATCHED_DATA_RE = re.compile(r"\[MATCHED_DATA\]\s*(\{.*?\})\s*\[/MATCHED_DATA\]", re.DOTALL)


def test_specialist_tools_import_cleanly() -> None:
    assert callable(insights_agent_tool)
    assert callable(document_agent_tool)


def test_supervisor_tools_list_has_exactly_two_specialists() -> None:
    """Locked architecture: exactly 2 specialists wrapped as tools, no more, no less."""
    assert len(SUPERVISOR_TOOLS) == 2
    assert insights_agent_tool in SUPERVISOR_TOOLS
    assert document_agent_tool in SUPERVISOR_TOOLS


def test_supervisor_truthfully_distinguishes_real_and_unimplemented_writes() -> None:
    assert "Document approval and rejection" in SUPERVISOR_SYSTEM_PROMPT
    assert "action tool actually executed successfully" in SUPERVISOR_SYSTEM_PROMPT
    assert "user explicitly requests" in SUPERVISOR_SYSTEM_PROMPT
    assert "returns a successful result" in SUPERVISOR_SYSTEM_PROMPT
    assert "unimplemented" in SUPERVISOR_SYSTEM_PROMPT
    assert "Nothing you or a specialist does executes a real change" not in SUPERVISOR_SYSTEM_PROMPT


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
    reason="No live model configured for MODEL_PROVIDER - skipping flagship end-to-end integration test",
)
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
      3. The underlying get_available_stock tool actually executed with a
         real product_ids filter covering 103 and 108 - proof the threading
         reached all the way down to a real, non-generic tool call, not
         just that the Supervisor's text happened to mention the numbers.
      4. The final response reflects the real shortage (Mechanical Keyboard
         short of the requested quantity), not generic restock language.
    """
    recorded_product_id_calls: list[list[int] | None] = []
    original_get_available_stock_mock = insights_mock_data.get_available_stock_mock

    def recording_get_available_stock_mock(product_ids: list[int] | None = None) -> dict:
        recorded_product_id_calls.append(product_ids)
        return original_get_available_stock_mock(product_ids=product_ids)

    monkeypatch.setattr(insights_mock_data, "get_available_stock_mock", recording_get_available_stock_mock)

    agent = build_supervisor_agent()
    result = agent(
        f"An order document just came in (doc_type=order, document_id={KNOWN_ORDER_DOCUMENT_ID}) "
        "from Bluewater Retail Group for a 27in Monitor and a Mechanical Keyboard. Process "
        "the document and tell me whether we can actually fulfill it right now."
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

    # 3. The real get_available_stock tool executed with a genuine
    # product_ids filter covering both items - not a None/generic call.
    assert any(
        ids is not None and {103, 108} <= set(ids) for ids in recorded_product_id_calls
    ), f"Expected a get_available_stock call filtered to include product_ids 103 and 108, got: {recorded_product_id_calls!r}"

    # 4. The final answer reflects the real shortage, not generic restock
    # language - Mechanical Keyboard (108, 4 available) is short of the 25
    # requested; the 27in Monitor (103, 48 available) is not.
    lowered = final_text.lower()
    assert "mechanical keyboard" in lowered, f"Expected the shortfall item to be named. Response: {final_text!r}"
    shortage_language = ("short", "not enough", "cannot", "can't", "insufficient", "unable to fulfill")
    assert any(term in lowered for term in shortage_language), (
        f"Expected the response to state the order can't be fully fulfilled. Response: {final_text!r}"
    )
