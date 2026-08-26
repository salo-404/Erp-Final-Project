"""Semantic (meaning + wording) matching layer for the Document agent's
product/supplier resolution.

Blends two independent signals so a paraphrased or reworded extracted name
still resolves correctly, not just near-verbatim text:

  - LEXICAL: rapidfuzz.fuzz.WRatio (see agents/document_agent/tools.py's
    _classify_fuzzy_match) - wording/character similarity. Catches typos,
    transposed letters, and reordered words; blind to synonyms or
    paraphrase ("14-inch laptop" vs "Laptop Pro 14" scores low).
  - SEMANTIC: cosine similarity between Bedrock Titan embeddings (the same
    retrieval/embedding_service.embed_text() already used for SQL-RAG
    example retrieval) - meaning similarity. Catches a differently-worded
    but semantically equivalent name; blind to a purely typographical
    difference an embedding barely reacts to either way.

Neither signal alone satisfies "meaning + wording similarity" - only the
blend does (see _blend_scores()).

This module is pure supporting-signal logic plus embedding I/O only. It
never calls the real ERP backend and never decides the final
RESOLVED/UNRESOLVED/NO_MATCH status. Every id returned by rank_candidates()
is copied from the caller-supplied real candidate list; the actual Document
Agent LLM in matching_agent.py remains the sole semantic decision-maker.
"""

from __future__ import annotations

import asyncio
import math
from rapidfuzz import fuzz, utils

from retrieval.embedding_service import embed_text

# Same signal-strength thresholds as the legacy fuzzy matcher. They affect
# only the wording attached to advisory scores; they do not classify the
# final result.
# Kept as separate local constants (not imported) so this module stays
# import-independent of tools.py - same "each file stays self-contained"
# convention already used elsewhere in this codebase (e.g.
# _sum_po_items_value's docstring).
_MATCH_THRESHOLD = 80.0
_AMBIGUOUS_FLOOR = 60.0

# Weighting for LEXICAL vs SEMANTIC in the blended score - a REASONED
# DEFAULT, NOT empirically calibrated against real product/supplier data
# the way rapidfuzz's own 80/60 thresholds were (see
# agents/document_agent/tools.py::_classify_fuzzy_match's docstring for
# that calibration). Semantic gets the larger weight because catching
# paraphrased/reworded wording - the entire reason this module exists - is
# exactly what lexical scoring alone cannot do. Lexical still counts for
# real: a confident textual match is strong evidence too, and short product
# names can occasionally embed as vaguely similar despite naming different
# things. Revisit if real extracted-text variance data ever becomes
# available.
_LEXICAL_WEIGHT = 0.4
_SEMANTIC_WEIGHT = 0.6


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Real cosine similarity between two equal-length embedding vectors.

    No numpy dependency - pure Python; vectors are 512-d and this runs at
    most a handful of times per tool call (real catalog size is single
    digits to low tens - see agents/document_agent/tools.py). Returns 0.0
    for a degenerate (all-zero) vector rather than dividing by zero - never
    a fabricated similarity for something that carries no real signal.
    """
    if len(a) != len(b):
        raise ValueError(f"Embedding dimension mismatch: {len(a)} vs {len(b)}")
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _blend_scores(lexical_score: float, semantic_similarity: float) -> float:
    """Combine a native-0-100 rapidfuzz score with a [-1, 1] cosine
    similarity into one native-0-100 blended confidence - the same 0-100
    convention every other confidence field in this codebase already uses
    (ProductMatch.confidence, FindSupplierResponse.confidence, etc.).

    semantic_similarity is clamped to >= 0 before blending: a negative
    cosine similarity carries no positive evidence of a match, and letting
    it pull the blended score below the lexical-only contribution would let
    embedding noise penalize a candidate that is genuinely wording-similar.

    KNOWN, ACCEPTED LIMITATION (same category as _classify_fuzzy_match's
    "Mouse Pad" false-positive note in agents/document_agent/tools.py, not
    a bug to fix here): because SEMANTIC carries the larger weight, an
    otherwise strong lexical match (even a raw 100) cannot cross the
    RESOLVED threshold on its own if the embedding call happens to return
    an unexpectedly low similarity for it - real embeddings of identical or
    near-identical short text are consistently high-similarity in practice,
    so this is not expected to bite for a genuine near-duplicate name, but
    it is a real tradeoff of weighting meaning over wording rather than a
    theoretical one. If it ever does, resolve_document_product()/
    resolve_document_supplier() (unaffected by this module, since they
    never call it) remain available as a fallback/baseline - see
    agents/document_agent/tools.py.
    """
    semantic_component = max(semantic_similarity, 0.0) * 100.0
    return _LEXICAL_WEIGHT * lexical_score + _SEMANTIC_WEIGHT * semantic_component


def _lexical_score(raw_text: str, candidate_name: str) -> float:
    return fuzz.WRatio(raw_text, candidate_name, processor=utils.default_process)


async def _embed_many(texts: list[str]) -> list[list[float]]:
    """Embed every text concurrently via asyncio.to_thread.

    Calls the module-level embed_text by name (not a bound default
    parameter) - same convention as tools/query_database.py - so tests can
    monkeypatch this module's own `embed_text` attribute
    (monkeypatch.setattr(semantic_match_module, "embed_text", fake)) the
    same way test_sql_rag_config.py already does for query_database.py.
    A default-parameter binding would capture the real function at import
    time and silently ignore that kind of patch.

    embed_text makes a real, blocking boto3 Bedrock call per text -
    asyncio.to_thread keeps that off the event loop (same pattern
    backend_client.py's Cognito auth uses), and running every text
    concurrently keeps an N-candidate catalog lookup from costing N
    sequential network round trips.
    """
    return list(await asyncio.gather(*(asyncio.to_thread(embed_text, text) for text in texts)))


def _match_reason(lexical_score: float, semantic_similarity: float) -> str:
    """Deterministic, built in Python from the two real scores - never left
    to the model to invent (same convention as e.g.
    ChooseFulfillmentWarehouseResponse.reason in tools/schemas/document_schema.py).
    """
    semantic_pct = max(semantic_similarity, 0.0) * 100.0
    strong_lexical = lexical_score >= _MATCH_THRESHOLD
    strong_semantic = semantic_pct >= _MATCH_THRESHOLD
    if strong_lexical and strong_semantic:
        return "Wording and meaning both closely match this candidate."
    if strong_semantic and not strong_lexical:
        return "Different wording, but the meaning closely matches this candidate."
    if strong_lexical and not strong_semantic:
        return "Wording closely matches this candidate; meaning similarity is weaker."
    if lexical_score >= _AMBIGUOUS_FLOOR or semantic_pct >= _AMBIGUOUS_FLOOR:
        return "Only a partial match on wording and meaning."
    return "Weak match on both wording and meaning."


async def rank_candidates(raw_text: str, candidates: list[dict]) -> list[dict]:
    """Score raw_text against every real candidate ({"id", "name"}) using
    the blended lexical+semantic signal, sorted by blended confidence
    descending.

    Returns one entry per candidate: {"id", "name", "lexicalScore"
    (rapidfuzz, native 0-100), "semanticScore" (cosine similarity, -1 to
    1), "confidence" (the blended 0-100 score), "reason"}. Never filters -
    that is the caller's job (e.g. keeping only the top 3); this function
    only scores and ranks the full input list.

    Real IDs only: every "id" in the output is copied directly from the
    caller-supplied candidates list - this function never invents one.
    """
    if not candidates:
        return []

    query_embedding, *candidate_embeddings = await _embed_many(
        [raw_text] + [candidate["name"] for candidate in candidates]
    )

    scored = []
    for candidate, candidate_embedding in zip(candidates, candidate_embeddings):
        lexical = _lexical_score(raw_text, candidate["name"])
        semantic = _cosine_similarity(query_embedding, candidate_embedding)
        scored.append(
            {
                "id": candidate["id"],
                "name": candidate["name"],
                "lexicalScore": lexical,
                "semanticScore": semantic,
                "confidence": _blend_scores(lexical, semantic),
                "reason": _match_reason(lexical, semantic),
            }
        )

    scored.sort(key=lambda entry: entry["confidence"], reverse=True)
    return scored


def normalize_extracted_name(raw_text: str) -> str:
    """Clean up an extracted, unmatched name into a human-reviewable
    suggested catalog name - a REASONED DEFAULT, not empirically validated
    (same caveat as the blend weights above): collapse whitespace, and
    capitalize each word UNLESS it already carries meaningful casing (an
    acronym like "USB-C", "HD" - naive str.title() would wrongly rewrite
    "USB-C" to "Usb-C", confirmed against this catalog's own real product
    names). Never reorders or invents/removes words - formatting cleanup
    only, never a reword.
    """
    cleaned = " ".join(raw_text.strip().split())
    words = []
    for word in cleaned.split(" "):
        if not word:
            continue
        already_cased = word.isupper() or any(character.isupper() for character in word[1:])
        words.append(word if already_cased else word[:1].upper() + word[1:])
    return " ".join(words)
