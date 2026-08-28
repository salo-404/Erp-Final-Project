"""Tests for agents/document_agent/matching_agent.py - the Document
agent's real, narrow, non-chat product/supplier matching invocation.

Offline tests (no live model, no network) verify the mechanics: prompt
construction, the empty-candidates short-circuit, advisory-hint
best-effort computation, the post-call safety validation
(_validate_verdict - invented-id rejection, candidate-count/status
consistency), timeout handling, and structured-output-None handling -
using a FakeAgent, same pattern as tests/test_gate.py's is_in_scope()
tests (a separate, small, tool-free Agent instance sharing a model role).

Live tests (marked skipif not live_model_configured(), same convention as
tests/test_gate.py's IN_SCOPE_QUERIES/OUT_OF_SCOPE_QUERIES and
tests/test_document_agent.py's two live-model tests) make REAL calls
through settings.build_model("document") - the actual Document agent LLM,
not a mock - proving the model itself performs the semantic reasoning:
exact match, a genuinely differently-worded paraphrase, two ambiguous
candidates, no real match at all (with a recommendation), and a supplier
match. These are the tests that answer "is the Document Agent LLM actually
invoked for matching" - not a mocked assertion.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from agents.document_agent import matching_agent as matching_agent_module
from agents.document_agent.matching_agent import (
    DocumentAgentMatchCandidate,
    DocumentAgentMatchRecommendation,
    DocumentAgentMatchTimeout,
    DocumentAgentMatchVerdict,
    InvalidDocumentAgentMatchOutput,
    _validate_verdict,
    match_candidates_with_document_agent,
)
from tests._helpers import live_model_configured

_REAL_PRODUCT_CANDIDATES = [
    {"id": 73, "name": "Laptop Pro 14", "category": "Electronics", "description": None},
    {"id": 74, "name": "Wireless Mouse", "category": "Electronics", "description": None},
    {"id": 75, "name": "Mechanical Keyboard", "category": "Electronics", "description": None},
    {"id": 76, "name": "27-inch Monitor", "category": "Electronics", "description": None},
    {"id": 77, "name": "USB-C Dock", "category": None, "description": None},
]
_REAL_SUPPLIER_CANDIDATES = [
    {"id": 41, "name": "TechSource Lebanon", "email": None, "leadTimeDays": None},
    {"id": 42, "name": "Cedar Electronics", "email": None, "leadTimeDays": None},
    {"id": 43, "name": "Levant Trading", "email": None, "leadTimeDays": None},
]


# ---------------------------------------------------------------------------
# Offline: no live model, no network - FakeAgent pattern (see
# tests/test_gate.py's is_in_scope() tests for the same convention).
# ---------------------------------------------------------------------------


class FakeAgent:
    """Records the prompt it was called with and returns a canned verdict -
    same shape as tests/test_gate.py's FakeAgent for is_in_scope()."""

    last_prompt: str | None = None
    last_system_prompt: str | None = None
    verdict: DocumentAgentMatchVerdict | None = None
    delay_seconds: float = 0.0

    def __init__(self, **kwargs):
        FakeAgent.last_system_prompt = kwargs.get("system_prompt")
        assert kwargs["tools"] == []

    def __call__(self, prompt, structured_output_model):
        assert structured_output_model is DocumentAgentMatchVerdict
        FakeAgent.last_prompt = prompt
        if FakeAgent.delay_seconds:
            time.sleep(FakeAgent.delay_seconds)
        return SimpleNamespace(structured_output=FakeAgent.verdict)


def _install_fake_agent(monkeypatch: pytest.MonkeyPatch, verdict, *, delay_seconds: float = 0.0) -> None:
    FakeAgent.verdict = verdict
    FakeAgent.delay_seconds = delay_seconds
    FakeAgent.last_prompt = None
    monkeypatch.setattr(
        matching_agent_module,
        "settings",
        SimpleNamespace(
            build_model=lambda _: object(),
            document_matching_timeout_seconds=matching_agent_module.settings.document_matching_timeout_seconds,
        ),
    )
    monkeypatch.setattr(matching_agent_module, "Agent", FakeAgent)


def test_empty_candidates_short_circuits_without_calling_the_model(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden_agent(**kwargs):
        raise AssertionError("the model must not be called when there are no real candidates")

    monkeypatch.setattr(matching_agent_module, "Agent", forbidden_agent)

    result = asyncio.run(match_candidates_with_document_agent("product", "Anything", []))

    assert result.status == "NO_MATCH"
    assert result.candidates == []
    assert result.recommendation == DocumentAgentMatchRecommendation(normalizedName="Anything")


def test_empty_candidates_supplier_has_no_recommendation(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden_agent(**kwargs):
        raise AssertionError("the model must not be called when there are no real candidates")

    monkeypatch.setattr(matching_agent_module, "Agent", forbidden_agent)

    result = asyncio.run(match_candidates_with_document_agent("supplier", "Anything", []))

    assert result.status == "NO_MATCH"
    assert result.recommendation is None


def test_prompt_includes_real_candidates_and_categories(monkeypatch: pytest.MonkeyPatch) -> None:
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="14-inch Laptop"),
    )
    _install_fake_agent(monkeypatch, verdict)
    monkeypatch.setattr(matching_agent_module, "rank_candidates", _raising_rank_candidates)

    asyncio.run(match_candidates_with_document_agent("product", "14-inch Laptop", _REAL_PRODUCT_CANDIDATES))

    prompt = FakeAgent.last_prompt
    assert 'Extracted text: "14-inch Laptop"' in prompt
    assert "id=73 name='Laptop Pro 14' category=Electronics" in prompt
    assert "id=77 name='USB-C Dock' category=null" in prompt
    assert "Existing real categories in the catalog: Electronics" in prompt


async def _raising_rank_candidates(*args, **kwargs):
    raise RuntimeError("simulated embedding service outage")


def test_hint_computation_failure_does_not_block_the_real_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Advisory hints are best-effort - see matching_agent._compute_hints().
    A failure there must not prevent the real Document agent call."""
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="Anything"),
    )
    _install_fake_agent(monkeypatch, verdict)
    monkeypatch.setattr(matching_agent_module, "rank_candidates", _raising_rank_candidates)

    result = asyncio.run(
        match_candidates_with_document_agent("product", "Anything", _REAL_PRODUCT_CANDIDATES)
    )

    assert result.status == "NO_MATCH"
    assert "Advisory wording+meaning similarity hints" not in FakeAgent.last_prompt


def test_hints_are_included_in_the_prompt_when_available(monkeypatch: pytest.MonkeyPatch) -> None:
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="Laptop Pro 14"),
    )
    _install_fake_agent(monkeypatch, verdict)

    async def fake_rank_candidates(query, candidates):
        return [
            {"id": 73, "name": "Laptop Pro 14", "confidence": 91.2, "lexicalScore": 90.0, "semanticScore": 0.9, "reason": "r"},
        ]

    monkeypatch.setattr(matching_agent_module, "rank_candidates", fake_rank_candidates)

    asyncio.run(match_candidates_with_document_agent("product", "Laptop Pro 14", _REAL_PRODUCT_CANDIDATES))

    prompt = FakeAgent.last_prompt
    assert "Advisory wording+meaning similarity hints" in prompt
    assert "id=73 name='Laptop Pro 14': 91.2/100" in prompt


def test_supplier_prompt_includes_metadata_and_no_categories_section(monkeypatch: pytest.MonkeyPatch) -> None:
    verdict = DocumentAgentMatchVerdict(status="NO_MATCH", candidates=[])
    _install_fake_agent(monkeypatch, verdict)
    monkeypatch.setattr(matching_agent_module, "rank_candidates", _raising_rank_candidates)

    candidates = [{"id": 41, "name": "TechSource Lebanon", "email": "hello@techsource.example", "leadTimeDays": 5}]
    asyncio.run(match_candidates_with_document_agent("supplier", "Tech Source Lebanon", candidates))

    prompt = FakeAgent.last_prompt
    assert "id=41 name='TechSource Lebanon' email=hello@techsource.example leadTimeDays=5" in prompt
    assert "Existing real categories" not in prompt


def test_structured_output_none_raises_invalid_output(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_agent(monkeypatch, None)
    monkeypatch.setattr(matching_agent_module, "rank_candidates", _raising_rank_candidates)

    with pytest.raises(InvalidDocumentAgentMatchOutput, match="no parseable structured output"):
        asyncio.run(match_candidates_with_document_agent("product", "Anything", _REAL_PRODUCT_CANDIDATES))


def test_call_exceeding_timeout_raises_document_agent_match_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    verdict = DocumentAgentMatchVerdict(status="NO_MATCH", candidates=[])
    _install_fake_agent(monkeypatch, verdict, delay_seconds=0.5)
    monkeypatch.setattr(matching_agent_module, "rank_candidates", _raising_rank_candidates)
    # Overrides _install_fake_agent's own settings patch with a much
    # shorter timeout, so this specific test actually exercises the
    # asyncio.wait_for() timeout path in a fraction of a second.
    monkeypatch.setattr(
        matching_agent_module,
        "settings",
        SimpleNamespace(build_model=lambda _: object(), document_matching_timeout_seconds=0.05),
    )

    with pytest.raises(DocumentAgentMatchTimeout, match="exceeded 0.05s"):
        asyncio.run(match_candidates_with_document_agent("product", "Slow", _REAL_PRODUCT_CANDIDATES))


# ---------------------------------------------------------------------------
# _validate_verdict: pure logic, the real safety net against a hallucinated
# id or an internally inconsistent verdict - see this module's docstring.
# ---------------------------------------------------------------------------


def _validate(verdict, *, entity_type="product", real_ids, real_categories=frozenset()):
    return _validate_verdict(verdict, entity_type=entity_type, real_ids=real_ids, real_categories=real_categories)


def test_validate_verdict_rejects_an_invented_id() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="RESOLVED",
        candidates=[DocumentAgentMatchCandidate(id=99999, name="Made Up", confidence=0.9, reason="r")],
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="99999"):
        _validate(verdict, real_ids={73, 74, 75})


def test_validate_verdict_rejects_duplicate_candidate_ids() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="UNRESOLVED",
        candidates=[
            DocumentAgentMatchCandidate(id=73, name="X", confidence=0.6, reason="r"),
            DocumentAgentMatchCandidate(id=73, name="X again", confidence=0.5, reason="r"),
        ],
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="duplicate candidate id 73"):
        _validate(verdict, real_ids={73, 74})


def test_validate_verdict_rejects_an_empty_candidate_reason() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="RESOLVED",
        candidates=[DocumentAgentMatchCandidate(id=73, name="X", confidence=0.9, reason="   ")],
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="empty reason"):
        _validate(verdict, real_ids={73})


def test_validate_verdict_rejects_more_than_three_candidates() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="UNRESOLVED",
        candidates=[
            DocumentAgentMatchCandidate(id=i, name=f"P{i}", confidence=0.5, reason="r") for i in (73, 74, 75, 76)
        ],
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="maximum is 3"):
        _validate(verdict, real_ids={73, 74, 75, 76})


def test_validate_verdict_rejects_resolved_with_no_candidates() -> None:
    verdict = DocumentAgentMatchVerdict(status="RESOLVED", candidates=[])
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="RESOLVED with 0 candidates"):
        _validate(verdict, real_ids={73})


def test_validate_verdict_rejects_resolved_with_more_than_one_candidate() -> None:
    """RESOLVED means exactly one definitive match, never a resolved
    answer that's secretly a list of options."""
    verdict = DocumentAgentMatchVerdict(
        status="RESOLVED",
        candidates=[
            DocumentAgentMatchCandidate(id=73, name="A", confidence=0.9, reason="r"),
            DocumentAgentMatchCandidate(id=74, name="B", confidence=0.8, reason="r"),
        ],
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="RESOLVED with 2 candidates"):
        _validate(verdict, real_ids={73, 74})


def test_validate_verdict_rejects_unresolved_with_no_candidates() -> None:
    verdict = DocumentAgentMatchVerdict(status="UNRESOLVED", candidates=[])
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="UNRESOLVED with no candidates"):
        _validate(verdict, real_ids={73})


def test_validate_verdict_rejects_no_match_with_candidates() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[DocumentAgentMatchCandidate(id=73, name="X", confidence=0.5, reason="r")],
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="NO_MATCH with non-empty candidates"):
        _validate(verdict, real_ids={73})


def test_validate_verdict_strips_a_recommendation_attached_outside_no_match_instead_of_rejecting() -> None:
    # A recommendation is purely advisory extra data - it never drives the
    # match decision - so a model that attaches one to an otherwise
    # well-reasoned UNRESOLVED verdict shouldn't have its real, correct
    # candidates thrown away over that one extraneous field. See the
    # comment on this check in matching_agent.py for the full reasoning.
    verdict = DocumentAgentMatchVerdict(
        status="UNRESOLVED",
        candidates=[DocumentAgentMatchCandidate(id=73, name="X", confidence=0.6, reason="r")],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="X"),
    )
    _validate(verdict, real_ids={73})
    assert verdict.recommendation is None
    assert verdict.status == "UNRESOLVED"
    assert len(verdict.candidates) == 1


def test_validate_verdict_strips_a_supplier_recommendation_instead_of_rejecting() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="New Supplier"),
    )
    _validate(verdict, entity_type="supplier", real_ids={41})
    assert verdict.recommendation is None
    assert verdict.status == "NO_MATCH"


def test_validate_verdict_rejects_product_no_match_without_recommendation() -> None:
    verdict = DocumentAgentMatchVerdict(status="NO_MATCH", candidates=[])
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="without a new-product recommendation"):
        _validate(verdict, real_ids={73})


def test_validate_verdict_rejects_empty_recommendation_name() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="   "),
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="empty normalizedName"):
        _validate(verdict, real_ids={73})


def test_validate_verdict_rejects_a_category_outside_the_real_set() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="X", category="Made Up Category"),
    )
    with pytest.raises(InvalidDocumentAgentMatchOutput, match="Made Up Category"):
        _validate(verdict, real_ids={73}, real_categories={"Electronics", "Furniture"})


def test_validate_verdict_accepts_a_grounded_category_recommendation() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="NO_MATCH",
        candidates=[],
        recommendation=DocumentAgentMatchRecommendation(normalizedName="X", category="Electronics"),
    )
    _validate(verdict, real_ids={73}, real_categories={"Electronics"})  # must not raise


def test_validate_verdict_accepts_a_consistent_resolved_verdict() -> None:
    verdict = DocumentAgentMatchVerdict(
        status="RESOLVED",
        candidates=[DocumentAgentMatchCandidate(id=73, name="Laptop Pro 14", confidence=0.97, reason="r")],
    )
    _validate(verdict, real_ids={73, 74})  # must not raise


# ---------------------------------------------------------------------------
# Live: real calls through settings.build_model("document") - the actual
# proof the Document agent's own LLM performs the semantic reasoning, not
# a mock. Skips cleanly with no credentials, runs automatically once a
# provider is configured (see tests/_helpers.py).
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping Document agent matching live test",
)
def test_live_exact_product_match_resolves() -> None:
    result = asyncio.run(
        match_candidates_with_document_agent("product", "Laptop Pro 14", _REAL_PRODUCT_CANDIDATES)
    )
    assert result.status == "RESOLVED"
    assert result.candidates[0].id == 73
    assert result.candidates[0].confidence > 0.5
    assert result.candidates[0].reason


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping Document agent matching live test",
)
def test_live_semantically_similar_wording_is_recognized() -> None:
    """A genuinely reworded name with almost no shared wording - lexical
    matching alone would not resolve this; the model must reason about
    meaning to recognize it (or honestly say UNRESOLVED - never NO_MATCH,
    since a real, plausible candidate does exist)."""
    result = asyncio.run(
        match_candidates_with_document_agent("product", "14 inch laptop computer", _REAL_PRODUCT_CANDIDATES)
    )
    assert result.status in ("RESOLVED", "UNRESOLVED")
    assert any(candidate.id == 73 for candidate in result.candidates)


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping Document agent matching live test",
)
def test_live_ambiguous_ties_stay_unresolved() -> None:
    ambiguous_candidates = [
        {"id": 78, "name": "Office Headset", "category": None, "description": None},
        {"id": 80, "name": "Office Chair", "category": None, "description": None},
    ]
    result = asyncio.run(
        match_candidates_with_document_agent("product", "Office", ambiguous_candidates)
    )
    assert result.status != "RESOLVED"


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping Document agent matching live test",
)
def test_live_no_real_match_returns_no_match_with_recommendation() -> None:
    result = asyncio.run(
        match_candidates_with_document_agent("product", "Standing Desk Lamp", _REAL_PRODUCT_CANDIDATES)
    )
    assert result.status == "NO_MATCH"
    assert result.candidates == []
    assert result.recommendation is not None
    assert result.recommendation.normalizedName


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping Document agent matching live test",
)
def test_live_supplier_match_with_extra_wording_resolves_or_unresolved() -> None:
    result = asyncio.run(
        match_candidates_with_document_agent(
            "supplier", "Tech Source Lebanon Ltd", _REAL_SUPPLIER_CANDIDATES
        )
    )
    assert result.status in ("RESOLVED", "UNRESOLVED")
    assert any(candidate.id == 41 for candidate in result.candidates)
    assert result.recommendation is None
