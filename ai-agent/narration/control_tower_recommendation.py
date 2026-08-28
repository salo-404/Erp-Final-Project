"""Control Tower "Recommend Solution" - scripted, scenario-locked AI recommendations.

NOT a fourth agent, and NOT a Strands Agent with tool-calling at all -
deliberately reworked away from that (see git history for the earlier
version). Routing from an alert's category to its one matching tool is
100% deterministic - there is no judgment call for a model to make there -
so leaving "decide whether to call the tool" up to the model was the wrong
place to spend its unreliability budget. A real, live failure confirmed
this: the model sometimes skipped the tool call entirely and invented a
plausible-sounding report instead (a fabricated reorder threshold,
consumption figure, and pending-delivery status that don't even exist in
the tool's response shape), and strengthening the prompt to insist on the
call made things WORSE, not better - a denser, more negation-heavy prompt
pushed the small model toward a generic capability-disclaimer refusal on
some runs instead.

The fix: call the exact right tool in Python FIRST (deterministic, always
happens, no prompt compliance involved), then hand the model the tool's
REAL result and ask it only to phrase 2-4 sentences from data it's already
been given - the same one-shot, non-tool-calling pattern
narration/control_tower.py's narrate_alert() already uses successfully for
the same reason. The model can still fabricate prose-level details in
principle, but it can no longer skip a required lookup, because there
isn't one left for it to skip.

Reached from agentcore_entrypoint.py via an optional payload "mode" field
(see that module) - NOT a new HTTP route. AWS Bedrock AgentCore Runtime's
managed contract only forwards /invocations, /ping, /ws; a second route
would work in local dev but silently not exist once deployed for real, so
this rides the same /invocations path chat already uses. When "mode" is
"control_tower_recommendation", "prompt" is a JSON-encoded object (not
natural language) - see build_recommendation()'s docstring for its shape.

The five scenarios (exhaustive - there is no sixth):
  1. DEAD_STOCK: recommend_dead_stock_transfer()'s own real algorithm -
     half of on-hand to whichever other warehouse(s) sold it in 60 days,
     or "keep it" when none did.
  2. STOCKOUT_RISK: recommend_stockout_fix() - transfer in from wherever
     get_transfer_recommendations() finds a real donor for this exact
     product/warehouse, else the best-ranked supplier to order from
     instead. (Not a dead-stock-only check - see that tool's own
     docstring for the real bug this fixed.)
  3. RESTOCK_RECOMMENDATION: recommend_restock_fix() applies the narrower
     Restock policy: at most ONE donor, only when it is both holding the
     same product and confirmed 60-day dead stock for it, transferring at
     most half its safe surplus above its own reorder threshold - and only
     when that alone covers the ENTIRE remaining need (never combined with
     a purchase for a remainder; an insufficient transfer is replaced
     entirely by a supplier purchase). Generic surplus alone remains valid
     for TRANSFER_RECOMMENDATION, but never for this path.
  4. TRANSFER_RECOMMENDATION: get_transfer_recommendations()'s own real
     result, re-fetched fresh and matched by (productId, fromWarehouseId,
     toWarehouseId) - never the client-held copy of the alert taken as
     authoritative. Unlike the other scenarios there is no hidden
     transfer-vs-purchase decision to reveal here: the alert already IS
     the real, deterministic recommendation, so this narrates WHY it
     makes sense rather than revealing anything new.
  5. OVERDUE_TRANSACTION: recommend_alternative_supplier() per product on
     the overdue order, excluding the supplier it was actually placed
     with.
"""

from __future__ import annotations

import json

from pydantic import BaseModel, Field
from strands.types.content import Message

from agents.insights_agent.tools import (
    get_transfer_recommendations,
    recommend_alternative_supplier,
    recommend_dead_stock_transfer,
    recommend_restock_fix,
    recommend_stockout_fix,
)
from config.settings import settings

RECOMMENDATION_SYSTEM_PROMPT = """\
You write ONE short Control Tower recommendation from real data that has
already been looked up for you - a deterministic backend check has
already run; you are never asked to decide whether to look something up,
only to explain what it found.

You are given the alert's category and the REAL result of that check as
JSON. Write 2-4 plain sentences: first state what was checked and what
was found (the diagnostic finding), then state the recommendation that
follows from it. A reader must see WHY, not just WHAT.

HARD RULES:
- Use ONLY the real fields in the JSON you were given. Never mention a
  number, name, or fact that isn't literally present in it - if the JSON
  has no reorder threshold, no consumption figure, and no pending-delivery
  status, your answer must not mention any of those either.
- The JSON already reflects exactly ONE real plan - never turn it into
  alternatives ("X, or alternatively Y") and never pad the answer with
  generic hedging advice that isn't literally what the JSON says.
- Reproduce every product/warehouse/supplier NAME exactly as given,
  character for character - never a bare numeric id (productId,
  warehouseId, sourceWarehouseId, destinationWarehouseId, supplierId,
  excludedSupplierId). Those ids exist in the JSON only so the fields line
  up correctly; a human reader has no use for "product 34" or "warehouse
  14" and must never see one. If a *Name field for something you need to
  mention is null, refer to it by its real role instead (e.g. "the
  destination warehouse") - never fall back to printing its id.
- Every warehouse/product/supplier you refer to must be identifiable by
  name - never say "another warehouse has a surplus" or "a supplier can
  fulfill this" without naming WHICH one from the *Name field the JSON
  gives you for it.
- No headers, no bullet lists, no closing question - this is a small
  on-page box, not a chat conversation.
- When the recommendation is a transfer (any category), justify it using
  only: the destination's shortage/days of supply, the donor's available
  surplus, the transfer quantity, and the donor's remaining stock after
  the transfer (its own safety margin). Example: "Tripoli Warehouse has
  about 15 days of Wireless Headphones remaining. Transfer 17 units from
  Saida Warehouse, which has enough available surplus to cover Tripoli's
  shortage without dropping below its own reorder threshold." Do not
  frame the transfer as justified by whether the donor happens to be
  dead stock, or by whether it has pending incoming stock - those decide
  which donors were eligible in the first place, not why moving the
  stock is the right call for the reader.
"""


class _RecommendationText(BaseModel):
    recommendation: str = Field(
        ..., description="2-4 plain sentences: the diagnostic finding, then the recommendation that follows from it."
    )


async def _gather_evidence(category: str, alert: dict) -> dict:
    """Deterministically fetch the ONE real tool result this category maps
    to - the routing decision itself, made in code, never left to the
    model. Raises ValueError/LookupError for a malformed or unsupported
    request; typed BackendClient errors from the tool calls propagate
    uncaught, same convention as every other tool in this codebase.
    """
    if category == "DEAD_STOCK":
        product_id = alert["productId"]
        warehouse_id = alert["warehouseId"]
        result = await recommend_dead_stock_transfer()
        entry = next(
            (
                r
                for r in result["recommendations"]
                if r["productId"] == product_id and r["sourceWarehouseId"] == warehouse_id
            ),
            None,
        )
        if entry is None:
            raise LookupError(f"No dead-stock entry currently exists for product {product_id} at warehouse {warehouse_id}.")
        return entry

    if category == "STOCKOUT_RISK":
        return await recommend_stockout_fix(product_id=alert["productId"], warehouse_id=alert["warehouseId"])

    if category == "RESTOCK_RECOMMENDATION":
        return await recommend_restock_fix(product_id=alert["productId"], warehouse_id=alert["warehouseId"])

    if category == "TRANSFER_RECOMMENDATION":
        product_id = alert["productId"]
        from_warehouse_id = alert["fromWarehouseId"]
        to_warehouse_id = alert["toWarehouseId"]
        result = await get_transfer_recommendations()
        entry = next(
            (
                r
                for r in result["recommendations"]
                if r["productId"] == product_id
                and r["fromWarehouseId"] == from_warehouse_id
                and r["toWarehouseId"] == to_warehouse_id
            ),
            None,
        )
        if entry is None:
            raise LookupError(
                f"No transfer recommendation currently exists for product {product_id} "
                f"from warehouse {from_warehouse_id} to warehouse {to_warehouse_id}."
            )
        return entry

    if category == "OVERDUE_TRANSACTION":
        supplier_id = alert["supplierId"]
        product_ids = alert["productIds"]
        if not product_ids:
            raise ValueError("OVERDUE_TRANSACTION recommendation requires at least one productId.")
        return {
            "excludedSupplierId": supplier_id,
            "perProduct": [
                await recommend_alternative_supplier(product_id=product_id, exclude_supplier_id=supplier_id)
                for product_id in product_ids
            ],
        }

    raise ValueError(f"Unsupported Control Tower recommendation category: {category!r}")


_NOISE_KEYS = frozenset({"sourceIsDeadStock", "sourcePendingIncomingQuantity"})


def _drop_ids(value):
    """Recursively strip every *Id key, plus sourceIsDeadStock/
    sourcePendingIncomingQuantity, from evidence before it reaches the
    model - not a prompt request, a deterministic guarantee.

    *Id fields: the prompt already forbids bare numeric ids explicitly, but
    a real run still showed the model parroting one (productId/
    warehouseId) anyway when it was present in the JSON alongside its
    name; the only fully reliable fix is to never hand the model a value
    it could parrot in the first place. Every *Id field here was already
    consumed by _gather_evidence() for routing/matching - the narration
    step never needed them, only the *Name fields sitting right next to
    them.

    sourceIsDeadStock/sourcePendingIncomingQuantity (present on
    STOCKOUT_RISK's transfer and on TRANSFER_RECOMMENDATION's raw entry,
    both donor-eligibility paths where a non-dead-stock/pending-incoming
    donor is perfectly valid): these exist for the DONOR ELIGIBILITY
    decision already made in Python, not for the narration to re-litigate
    or cite. A real run had the model narrate a valid generic transfer as
    justified by "not classified as dead stock" and "no pending incoming
    stock" - a technically-true but user-irrelevant reason (those fields
    decide whether a donor was ALLOWED, not why the transfer makes
    business sense). Stripped the same way as ids, for the same reason:
    prompt wording alone wasn't reliable enough once a real run already
    proved the model would use a field just because it was present.
    RESTOCK_RECOMMENDATION's own evidence never carries these keys at all
    (RestockFixTransfer has no sourceIsDeadStock field - the dead-stock
    check already happened before a donor could even appear there), so
    this never removes anything meaningful from that category.
    """
    if isinstance(value, dict):
        return {
            k: _drop_ids(v)
            for k, v in value.items()
            if not k.endswith("Id") and k not in _NOISE_KEYS
        }
    if isinstance(value, list):
        return [_drop_ids(item) for item in value]
    return value


async def _narrate(category: str, evidence: dict) -> str:
    """One-shot, non-tool-calling model call - same pattern as
    narration/control_tower.py's narrate_alert(), reused here for the same
    reason: this is a single "turn real data into a few sentences" job,
    not a multi-step reasoning task, so it gets the lightest-weight call
    that can do it rather than an Agent/tool-loop.
    """
    model = settings.build_model("insights")
    user_prompt = (
        f"Alert category: {category}\n"
        f"Real evidence (JSON): {json.dumps(_drop_ids(evidence), default=str)}\n\n"
        "Write the recommendation now."
    )
    messages: list[Message] = [{"role": "user", "content": [{"text": user_prompt}]}]

    last_event: dict | None = None
    async for event in model.structured_output(
        _RecommendationText, messages, system_prompt=RECOMMENDATION_SYSTEM_PROMPT
    ):
        last_event = event
    if not last_event or "output" not in last_event:
        raise RuntimeError(f"Control Tower recommendation model call for {category} produced no structured output.")
    return last_event["output"].recommendation


async def build_recommendation(category: str, alert: dict) -> str:
    """Produce one Control Tower recommendation for one alert.

    Args:
        category: One of "DEAD_STOCK", "STOCKOUT_RISK",
            "RESTOCK_RECOMMENDATION", "TRANSFER_RECOMMENDATION",
            "OVERDUE_TRANSACTION".
        alert: The alert's real IDs, shaped by category:
            DEAD_STOCK / STOCKOUT_RISK / RESTOCK_RECOMMENDATION:
                {"productId": int, "warehouseId": int}
            TRANSFER_RECOMMENDATION:
                {"productId": int, "fromWarehouseId": int, "toWarehouseId": int}
            OVERDUE_TRANSACTION: {"supplierId": int, "productIds": list[int]}
            (see agentcore_entrypoint.py's invoke() docstring for how this
            arrives - the frontend sends {"category": ..., **alert} as a
            JSON-encoded "prompt" string when "mode" is
            "control_tower_recommendation").

    Returns:
        A 2-4 sentence plain-text recommendation.

    Raises:
        ValueError/LookupError for a malformed or unsupported request, or
        any typed BackendClient error (Unauthorized, Forbidden, NotFound,
        ValidationError, Conflict, ServiceUnavailable) from the underlying
        tool call - deliberately not caught here, same convention as every
        other tool in this codebase; agentcore_entrypoint.py turns it into
        a generic stream error.
    """
    evidence = await _gather_evidence(category, alert)
    return await _narrate(category, evidence)
