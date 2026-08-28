"""Regression tests for agents/document_agent/semantic_match.py - the pure
lexical+embedding blend used ONLY as optional advisory hint generation for
agents/document_agent/matching_agent.py's real Document agent LLM matching
call (see that module's own docstring). This module is intentionally NOT
treated as an authoritative matcher anywhere anymore - the LLM is the final
decision-maker; these tests cover the hint-scoring math itself, not a
matching decision.

Real rapidfuzz WRatio scores used below (e.g. "Compact Rodent Pointer" vs
"Wireless Mouse" -> 32.14) were computed directly against rapidfuzz, not
guessed - see the module docstrings in semantic_match.py for the blend
formula these numbers feed into. embed_text is monkeypatched at
agents.document_agent.semantic_match (where _embed_many() actually calls
it by name at call time - NOT as a bound default parameter, so this is the
only patch point that works, same convention test_sql_rag_config.py uses
for tools/query_database.py's identically-shaped embed_text call).

Fake embeddings below are 2-D unit vectors [cos(deg), sin(deg)] so cosine
similarity between two crafted texts is exactly cos(angle difference) -
lets every scenario's semantic component be an exact, chosen number
(1.0, 0.8, 0.6, 0.5, 0.0, ...) rather than an opaque magic vector.
"""

from __future__ import annotations

import asyncio
import math

import pytest

from agents.document_agent import semantic_match as semantic_match_module
from agents.document_agent.semantic_match import (
    _blend_scores,
    _cosine_similarity,
    normalize_extracted_name,
    rank_candidates,
)


def _unit_vector(degrees: float) -> list[float]:
    radians = math.radians(degrees)
    return [math.cos(radians), math.sin(radians)]


def _fake_embed(mapping: dict[str, list[float]], default: list[float]):
    def embed(text: str) -> list[float]:
        return mapping.get(text, default)

    return embed


# ---------------------------------------------------------------------------
# Pure supporting-signal logic: cosine similarity and blending. Final
# RESOLVED/UNRESOLVED/NO_MATCH decisions belong to matching_agent.py's LLM.
# ---------------------------------------------------------------------------


def test_cosine_similarity_identical_and_orthogonal_vectors() -> None:
    assert _cosine_similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert _cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert _cosine_similarity([1.0, 0.0], [-1.0, 0.0]) == pytest.approx(-1.0)


def test_cosine_similarity_degenerate_vector_is_zero_not_a_crash() -> None:
    assert _cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0


def test_cosine_similarity_rejects_mismatched_dimensions() -> None:
    with pytest.raises(ValueError):
        _cosine_similarity([1.0, 0.0], [1.0, 0.0, 0.0])


def test_blend_scores_clamps_negative_semantic_similarity() -> None:
    # A negative cosine similarity must never pull the blend below the
    # lexical-only contribution - see _blend_scores' own docstring.
    assert _blend_scores(80.0, -1.0) == pytest.approx(0.4 * 80.0)


def test_blend_scores_native_0_to_100_scale() -> None:
    assert _blend_scores(100.0, 1.0) == pytest.approx(100.0)
    assert _blend_scores(0.0, 0.0) == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# normalize_extracted_name - pure formatting cleanup.
# ---------------------------------------------------------------------------


def test_normalize_extracted_name_collapses_whitespace_and_title_cases() -> None:
    assert normalize_extracted_name("  standing   desk lamp  ") == "Standing Desk Lamp"


def test_normalize_extracted_name_preserves_existing_acronym_casing() -> None:
    """Never mangles a real acronym the way naive str.title() would (e.g.
    "USB-C" -> "Usb-C") - see the function's own docstring."""
    assert normalize_extracted_name("USB-C hub") == "USB-C Hub"


# ---------------------------------------------------------------------------
# rank_candidates: end-to-end scoring/ranking with a monkeypatched
# embed_text - real IDs only, sorted by blended confidence. This is the
# exact function matching_agent.py's _compute_hints() calls to build the
# advisory hints included in the Document agent's prompt.
# ---------------------------------------------------------------------------


def test_rank_candidates_never_invents_an_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(semantic_match_module, "embed_text", _fake_embed({}, default=[1.0, 0.0]))
    candidates = [{"id": 73, "name": "Laptop Pro 14"}, {"id": 74, "name": "Wireless Mouse"}]
    ranked = asyncio.run(rank_candidates("Laptop Pro 14", candidates))
    real_ids = {c["id"] for c in candidates}
    assert {entry["id"] for entry in ranked} == real_ids


def test_rank_candidates_sorts_by_blended_confidence_descending(monkeypatch: pytest.MonkeyPatch) -> None:
    embed = _fake_embed(
        {"Query": _unit_vector(0), "Strong": _unit_vector(0), "Weak": _unit_vector(90)},
        default=_unit_vector(90),
    )
    monkeypatch.setattr(semantic_match_module, "embed_text", embed)
    ranked = asyncio.run(
        rank_candidates("Query", [{"id": 1, "name": "Weak"}, {"id": 2, "name": "Strong"}])
    )
    assert [entry["id"] for entry in ranked] == [2, 1]
    assert ranked[0]["confidence"] > ranked[1]["confidence"]


def test_rank_candidates_empty_catalog_returns_empty() -> None:
    assert asyncio.run(rank_candidates("Anything", [])) == []
