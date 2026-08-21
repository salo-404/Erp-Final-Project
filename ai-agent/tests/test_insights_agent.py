"""Smoke tests for the Insights agent.

Most of these tests call the @tool-decorated functions directly (Strands
tools are still plain, directly-callable Python functions - see
agents/insights_agent/tools.py) rather than invoking the full Agent, so they
run without any credentials or network access. They also verify the
standalone agent (module + tools) builds independently of the Supervisor.

Two additional tests actually call a real model (test_insights_agent_live_openai_smoke
via the OpenAI provider specifically, test_insights_agent_reports_tool_error_instead_of_fabricating
via whichever provider is configured) - see tests/_helpers.py for the skip
conditions. Neither touches a real backend - the tools they exercise stay
fully mocked.
"""

from __future__ import annotations

import pytest

from agents.insights_agent.agent import INSIGHTS_TOOLS, build_insights_agent
from agents.insights_agent.tools import (
    compare_suppliers,
)
from config.settings import settings
from tests._helpers import live_model_configured
from tools.mocks import insights_mock_data
from tools.query_database import query_database


def test_insights_agent_builds_standalone() -> None:
    """The Insights agent must construct without any Supervisor dependency."""
    agent = build_insights_agent()
    assert agent.name == "insights_agent"
    assert len(INSIGHTS_TOOLS) == 13
    assert query_database in INSIGHTS_TOOLS


def test_compare_suppliers_recommends_by_overall_score_not_just_cost() -> None:
    result = compare_suppliers(product_id=102)
    assert result
    assert len(result["scores"]) > 1
    recommended = result["recommendedSupplier"]
    assert "overallScore" in recommended

    cheapest = min(result["scores"], key=lambda s: s["unitCost"])
    # The mock data is deliberately set up so the recommended supplier is
    # NOT the cheapest one, proving the agent has something other than raw
    # cost to reason about (lead time / reliability).
    assert recommended["supplierId"] != cheapest["supplierId"]
    assert recommended["overallScore"] > cheapest["overallScore"]


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

    Forces get_available_stock to fail on its first call and asserts the
    agent's final answer is honest about it: either it genuinely retried (a
    second real call recorded below) or it clearly told the user the action
    failed - never that it silently claimed success with invented figures.
    Deliberately uses get_available_stock, not one of the stockout/
    dead-stock/supplier tools (those tested correctly already and are out
    of scope here) - this is testing the general tool-error-handling
    instruction, not any specific tool's behavior.
    """
    calls = {"n": 0}
    original_get_available_stock_mock = insights_mock_data.get_available_stock_mock

    def flaky_get_available_stock_mock() -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Simulated transient failure from the inventory service.")
        return original_get_available_stock_mock()

    monkeypatch.setattr(insights_mock_data, "get_available_stock_mock", flaky_get_available_stock_mock)

    agent = build_insights_agent()
    result = agent("What is our available stock right now? Give me a short summary.")
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
