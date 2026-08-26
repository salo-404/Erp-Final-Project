"""The Document agent's real, narrow, non-chat product/supplier matching
invocation - the actual decision-maker behind agentcore_entrypoint.py's
"document_match" /invocations mode (see that module's invoke() docstring).
The real ERP backend calls this by POSTing to the SAME AgentCore
/invocations endpoint the chat UI uses, with {"mode": "document_match",
"prompt": <JSON-encoded {entityType, query, candidates}>} - never a
bespoke HTTP route, and never Supervisor chat.

This is deliberately NOT a pure-algorithm path. The
agents/document_agent/semantic_match.py module is used here ONLY to compute
optional advisory wording/meaning hints
included in the prompt below (see _compute_hints()) - the actual
RESOLVED/UNRESOLVED/NO_MATCH verdict, confidence, and reason for every
candidate come from a real call to the Document agent's own configured LLM
(settings.build_model("document") - the SAME model role
build_document_agent() uses), reasoning over the real candidates the
backend already fetched.

Why a separate Agent construction rather than build_document_agent()
itself: build_document_agent() is a general-purpose, tool-equipped,
conversational agent (9 tools, a broad system prompt covering pending
reviews, duplicate checks, approve/reject, etc.) - correct for chat, wrong
for this narrow, single-shot, structured task where the backend has
ALREADY fetched the real candidates and there is nothing left to fetch.
This mirrors agents/supervisor/gate.py's is_in_scope() exactly: a separate,
small, tool-free Agent instance sharing a model ROLE with its "parent"
agent (there: "gate" alongside the Supervisor's "supervisor" role; here:
"document", the SAME role build_document_agent() itself uses - literally
the Document agent's own configured model), built fresh per call, used for
exactly one structured-output decision. This keeps the matching path
narrow and non-conversational (no tools, no session, no chat history)
while genuinely invoking the Document agent's own LLM to reason - not a
keyword/embedding algorithm standing in for it.

Safety: the model's structured output is NEVER trusted blindly.
_validate_verdict() enforces, after the call, that every returned
candidate id is one of the real ids the caller supplied (never invented,
never duplicated), that at most 3 candidates come back, that RESOLVED
means exactly one definitive candidate, UNRESOLVED means at least one
plausible candidate, NO_MATCH means none, that a recommendation only ever
accompanies NO_MATCH, that a supplier verdict never carries one at all,
and that a recommended category is always one of the real categories
supplied. Almost any violation - including a timeout or a call that
raises - is treated identically: this module raises, agentcore_entrypoint.py's
document_match mode turns that into an "error" SSE event, and the real ERP
backend (DocumentReviewService.resolveProduct()/resolveSupplier()) falls
back to its own existing fuzzy matcher. The one deliberate exception is a
recommendation attached somewhere it isn't allowed (a supplier, or
alongside RESOLVED/UNRESOLVED) - this model occasionally does that despite
the prompt forbidding it outright, and since the recommendation never
drives the actual match decision, _validate_verdict() strips the stray
field and keeps the rest of the (still fully validated) verdict rather
than discarding real, correctly-reasoned candidates over one extraneous
field. Every other validation failure is never silently downgraded or
partially trusted - and the backend independently re-validates the same
invariants again against its own candidate set before ever showing a
result to a human reviewer (defense in depth).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal, Optional

from pydantic import BaseModel, Field
from strands import Agent

from agents.document_agent.semantic_match import normalize_extracted_name, rank_candidates
from config.settings import settings

logger = logging.getLogger(__name__)

EntityType = Literal["product", "supplier"]
MatchStatus = Literal["RESOLVED", "UNRESOLVED", "NO_MATCH"]


class DocumentAgentMatchCandidate(BaseModel):
    id: int
    name: str
    confidence: float = Field(..., ge=0.0, le=1.0)
    reason: str


class DocumentAgentMatchRecommendation(BaseModel):
    normalizedName: str
    category: Optional[str] = None
    description: Optional[str] = None


class DocumentAgentMatchVerdict(BaseModel):
    status: MatchStatus
    candidates: list[DocumentAgentMatchCandidate] = Field(default_factory=list)
    recommendation: Optional[DocumentAgentMatchRecommendation] = Field(
        default=None,
        description=(
            "Leave this null/omitted UNLESS status is exactly NO_MATCH for a "
            "product. It is invalid to set this alongside a RESOLVED or "
            "UNRESOLVED status, or for a supplier - doing so gets the whole "
            "response rejected."
        ),
    )


class DocumentAgentMatchTimeout(RuntimeError):
    """The Document agent's structured-output call exceeded
    settings.document_matching_timeout_seconds. The underlying model call
    keeps running in its background thread (Python cannot forcibly kill a
    thread) - its eventual result is simply discarded; this is a deliberate,
    accepted tradeoff so the caller can move on to the fuzzy-matcher
    fallback without an unbounded wait.
    """


class InvalidDocumentAgentMatchOutput(RuntimeError):
    """The Document agent's structured output failed post-call validation -
    e.g. an invented id, more than 3 candidates, or an internally
    inconsistent status/candidates/recommendation combination. Callers
    treat this exactly like DocumentAgentMatchTimeout or a raw call
    exception: fail the request rather than accept output that might
    contain a fabricated id.
    """


DOCUMENT_MATCHING_SYSTEM_PROMPT = """\
You are the Document agent's product/supplier matching reasoner for a
warehouse and inventory management ERP. You are given ONE extracted name
from a Textract-scanned invoice or order, and the REAL, live catalog of
candidate products or suppliers already fetched from the backend database.
Your only job is to decide which real candidate (if any) the extracted
name refers to, using BOTH wording similarity AND meaning/semantic
similarity - a paraphrase, abbreviation, reordering, or reworded name can
still be the same real entity, and near-identical wording can still be a
DIFFERENT real entity (e.g. "Mouse Pad" is not a "Wireless Mouse").

Hard rules:

1. Every candidate id you return MUST be copied exactly from the supplied
   real candidate list. Never invent, guess, alter, or reuse an id from
   outside that list, and never return an id that was not supplied.

2. Return at most the top 3 real candidates, each with your own confidence
   (a number from 0.0 to 1.0) and a short, specific reason grounded in the
   actual wording/meaning comparison you made for THAT candidate - never a
   generic, templated, or copy-pasted reason. The reason MUST be ONE
   sentence, at most ~20 words - a human reviewer reads this at a glance,
   not a paragraph justifying your reasoning.

3. status is RESOLVED only when you are genuinely confident a single
   candidate is the same real-world entity, with no other candidate
   plausibly competing for the same identity. status is UNRESOLVED when
   one or more candidates are plausible but you are not confident enough
   to pick one, or two or more candidates are close enough to be
   genuinely ambiguous. status is NO_MATCH when no real candidate
   plausibly represents the same entity at all - candidates must then be
   an empty list.

4. recommendation is ONLY ever populated when status is NO_MATCH and
   entity_type is "product" - in EVERY other case (status is RESOLVED,
   status is UNRESOLVED, or entity_type is "supplier" regardless of
   status) you MUST leave recommendation null. This holds even if you
   personally think a new-product suggestion would be helpful alongside a
   RESOLVED or UNRESOLVED answer - a recommendation next to a real
   candidate is a contradiction (you cannot simultaneously say "this might
   be candidate X" and "this doesn't exist yet"), and the system will
   reject your entire response if you do this, discarding your matching
   work entirely. When you DO populate recommendation (NO_MATCH product
   only), give it: a normalizedName (the extracted text cleaned up for
   catalog readability only - never reworded, reordered, or reinvented), a
   category chosen ONLY from the real existing categories you were given
   (or null if none plausibly fits - never invent a new category name),
   and an optional short description GROUNDED ONLY in the extracted text
   itself - never invent specifications, pricing, dimensions, or
   attributes that were not present in the extracted text; use null when
   nothing meaningful beyond the name can honestly be said.

5. Any advisory wording/meaning similarity hints you are given were
   computed by a separate algorithm, not by you - they are a starting
   point only, never authoritative, and may be wrong. Use your own
   reasoning as the real decision; you may agree or disagree with a hint
   when you have good reason to.

6. Never fabricate a match, a confidence, or a reason. If you are
   uncertain, say so through UNRESOLVED rather than guessing - a wrong
   confident answer is worse than an honest "not sure."
"""


def _build_prompt(entity_type: EntityType, query: str, candidates: list[dict], hints: list[dict] | None) -> str:
    """Deterministic, built in Python from real data only - the candidate
    list, category list, and hints are exactly what was supplied/computed;
    nothing here is left to the model to infer or invent.
    """
    lines = [f"Entity type: {entity_type}", f'Extracted text: "{query}"', "", "Real candidates:"]

    for candidate in candidates:
        if entity_type == "product":
            category = candidate.get("category") or "null"
            description = candidate.get("description") or "null"
            lines.append(
                f"- id={candidate['id']} name={candidate['name']!r} category={category} description={description}"
            )
        else:
            metadata_bits = []
            if candidate.get("email"):
                metadata_bits.append(f"email={candidate['email']}")
            if candidate.get("leadTimeDays") is not None:
                metadata_bits.append(f"leadTimeDays={candidate['leadTimeDays']}")
            metadata = (" " + " ".join(metadata_bits)) if metadata_bits else ""
            lines.append(f"- id={candidate['id']} name={candidate['name']!r}{metadata}")

    if entity_type == "product":
        categories = sorted({candidate["category"] for candidate in candidates if candidate.get("category")})
        lines.append("")
        lines.append(
            "Existing real categories in the catalog: "
            + (", ".join(categories) if categories else "(none)")
        )

    if hints:
        lines.append("")
        lines.append(
            "Advisory wording+meaning similarity hints, 0-100 scale, NOT authoritative "
            "(computed by a separate algorithm - your own reasoning decides the final answer):"
        )
        for hint in sorted(hints, key=lambda entry: entry["confidence"], reverse=True)[:5]:
            lines.append(f"- id={hint['id']} name={hint['name']!r}: {hint['confidence']:.1f}/100")

    lines.append("")
    lines.append(
        "Decide which real candidate (if any) this extracted text refers to, "
        "and respond with your structured verdict."
    )
    return "\n".join(lines)


async def _compute_hints(query: str, candidates: list[dict]) -> list[dict] | None:
    """Best-effort advisory hints via the existing lexical+embedding blend
    (agents/document_agent/semantic_match.py) - never fatal to the real
    call below. A failure here (e.g. the embedding call itself fails)
    just means the model reasons without numeric hints, not that the
    whole request fails - the hints are supporting signal, not the
    decision-maker (see this module's own docstring).
    """
    try:
        return await rank_candidates(query, [{"id": c["id"], "name": c["name"]} for c in candidates])
    except Exception:  # noqa: BLE001 - genuinely best-effort, see docstring above
        logger.warning(
            "Could not compute advisory wording/meaning hints for the Document agent matching "
            "prompt - proceeding without them",
            exc_info=True,
        )
        return None


def _validate_verdict(
    verdict: DocumentAgentMatchVerdict,
    *,
    entity_type: EntityType,
    real_ids: set[int],
    real_categories: set[str],
) -> None:
    """Post-call safety net - the model's own structured output is never
    trusted blindly. See this module's docstring for why almost every
    violation here is a hard failure (never a partial/downgraded accept) -
    the one deliberate exception is a recommendation attached where it
    isn't allowed (a supplier, or alongside RESOLVED/UNRESOLVED), which is
    stripped rather than rejected - see the comment at that check below for
    why that specific case is safely correctable. The real ERP backend
    independently re-validates every one of these same invariants again
    against its own candidate set before ever showing a result to a human
    reviewer (defense in depth - this module's check is not the only line
    of defense).
    """
    if len(verdict.candidates) > 3:
        raise InvalidDocumentAgentMatchOutput(
            f"Document agent returned {len(verdict.candidates)} candidates, maximum is 3"
        )

    seen_ids: set[int] = set()
    for candidate in verdict.candidates:
        if candidate.id not in real_ids:
            raise InvalidDocumentAgentMatchOutput(
                f"Document agent returned id {candidate.id}, which was not in the supplied real candidates"
            )
        if candidate.id in seen_ids:
            raise InvalidDocumentAgentMatchOutput(
                f"Document agent returned duplicate candidate id {candidate.id}"
            )
        seen_ids.add(candidate.id)
        if not candidate.reason.strip():
            raise InvalidDocumentAgentMatchOutput(
                f"Document agent returned an empty reason for candidate id {candidate.id}"
            )

    # RESOLVED means "I am confident THIS is the one" - exactly one
    # definitive match, never a resolved answer that's secretly a list of
    # options. UNRESOLVED means plausible-but-not-confident, which requires
    # at least one real plausible candidate to point to - an UNRESOLVED
    # verdict with zero candidates isn't "unresolved," it's an unlabeled
    # NO_MATCH.
    if verdict.status == "RESOLVED" and len(verdict.candidates) != 1:
        raise InvalidDocumentAgentMatchOutput(
            f"Document agent returned status RESOLVED with {len(verdict.candidates)} candidates, expected exactly 1"
        )
    if verdict.status == "UNRESOLVED" and not verdict.candidates:
        raise InvalidDocumentAgentMatchOutput("Document agent returned status UNRESOLVED with no candidates")
    if verdict.status == "NO_MATCH" and verdict.candidates:
        raise InvalidDocumentAgentMatchOutput("Document agent returned status NO_MATCH with non-empty candidates")

    if entity_type == "product" and verdict.status == "NO_MATCH" and verdict.recommendation is None:
        raise InvalidDocumentAgentMatchOutput(
            "Document agent returned product NO_MATCH without a new-product recommendation"
        )

    # A recommendation attached to a supplier, or alongside a RESOLVED/
    # UNRESOLVED status, is a contradiction the prompt already forbids
    # explicitly (rule 4) - but this model still does it occasionally
    # anyway, tacking a "helpful" suggestion onto an otherwise well-reasoned
    # real candidate. Unlike an invented id or a genuinely wrong candidate
    # set, this is safely correctable: the recommendation never drives the
    # match decision itself, it's purely advisory extra data for the
    # NO_MATCH+new-product case. Dropping the stray field and keeping the
    # verdict's real (still fully validated below) candidates/status is
    # strictly better than discarding an otherwise-correct, genuinely-
    # reasoned answer over one extraneous field - the caller falling back
    # to the fuzzy matcher for THIS would throw away real Document agent
    # reasoning for no safety benefit.
    if verdict.recommendation is not None and (entity_type == "supplier" or verdict.status != "NO_MATCH"):
        logger.warning(
            "Document agent attached a recommendation to a %s %s verdict - dropping it "
            "(a recommendation is only ever valid for a product NO_MATCH)",
            entity_type,
            verdict.status,
        )
        verdict.recommendation = None

    if verdict.recommendation is not None:
        if not verdict.recommendation.normalizedName.strip():
            raise InvalidDocumentAgentMatchOutput(
                "Document agent returned a product recommendation with an empty normalizedName"
            )
        if verdict.recommendation.category is not None and verdict.recommendation.category not in real_categories:
            raise InvalidDocumentAgentMatchOutput(
                f"Document agent recommended category {verdict.recommendation.category!r}, "
                "which was not one of the real categories supplied"
            )


def _call_document_agent(prompt: str) -> DocumentAgentMatchVerdict | None:
    """Blocking - runs on the SAME model role build_document_agent() uses
    (settings.build_model("document")), with no tools and no chat
    history - see this module's docstring for why this is still genuinely
    "the Document agent" reasoning, not a different model standing in for
    it. Always run via asyncio.to_thread() by the caller, never called
    directly from an async context.
    """
    model = settings.build_model("document")
    agent = Agent(
        model=model,
        system_prompt=DOCUMENT_MATCHING_SYSTEM_PROMPT,
        tools=[],
        callback_handler=None,
        name="document_matching_agent",
        description="Document agent's narrow, non-chat product/supplier matching reasoner.",
    )
    result = agent(prompt, structured_output_model=DocumentAgentMatchVerdict)
    return result.structured_output


async def match_candidates_with_document_agent(
    entity_type: EntityType,
    query: str,
    candidates: list[dict],
) -> DocumentAgentMatchVerdict:
    """The real entry point agentcore_entrypoint.py's document_match mode calls.

    Empty candidates short-circuits to NO_MATCH without ever calling the
    model - there is nothing real to reason over. Otherwise: computes
    best-effort advisory hints, builds the prompt, invokes the Document
    agent's own configured LLM (via asyncio.to_thread + asyncio.wait_for
    for settings.document_matching_timeout_seconds - see
    DocumentAgentMatchTimeout), and validates the result before returning
    it - see _validate_verdict().

    Raises:
        DocumentAgentMatchTimeout: the model call exceeded the configured timeout.
        InvalidDocumentAgentMatchOutput: the model returned no parseable
            structured output, or output that failed validation (an
            invented id, too many candidates, or an inconsistent status).
        Any exception the model/provider call itself raises (network,
            credentials, throttling, etc.) - never caught or swallowed here.
    """
    if not candidates:
        recommendation = (
            DocumentAgentMatchRecommendation(normalizedName=normalize_extracted_name(query))
            if entity_type == "product"
            else None
        )
        return DocumentAgentMatchVerdict(status="NO_MATCH", candidates=[], recommendation=recommendation)

    real_ids = {candidate["id"] for candidate in candidates}
    real_categories = {candidate["category"] for candidate in candidates if candidate.get("category")}
    hints = await _compute_hints(query, candidates)
    prompt = _build_prompt(entity_type, query, candidates, hints)

    try:
        verdict = await asyncio.wait_for(
            asyncio.to_thread(_call_document_agent, prompt),
            timeout=settings.document_matching_timeout_seconds,
        )
    except asyncio.TimeoutError as exc:
        raise DocumentAgentMatchTimeout(
            f"Document agent matching call exceeded {settings.document_matching_timeout_seconds}s"
        ) from exc

    if verdict is None:
        raise InvalidDocumentAgentMatchOutput("Document agent returned no parseable structured output")

    _validate_verdict(verdict, entity_type=entity_type, real_ids=real_ids, real_categories=real_categories)
    return verdict
