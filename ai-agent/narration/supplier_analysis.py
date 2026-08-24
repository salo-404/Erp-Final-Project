"""On-demand supplier analysis narration - the "explain this supplier" feature.

Distinct from narration/control_tower.py's batch alert narration in two
ways: it's triggered on demand for ONE specific supplier, not looped over a
batch, and it narrates the backend's real supplier stats endpoints
(SuppliersService.getTransactionHistory() via GET /suppliers/:id/transactions,
SupplierIntelligenceService.getSupplierStats() via
GET /supplier-intelligence/:id/stats) rather than alert evidence. These are
the same real endpoints agents/insights_agent/tools.py's compare_suppliers()
already draws supplier quality data from - reused here via get_backend_client(),
not duplicated.

Same lightweight, non-agent pattern as control_tower.py: a single direct
call to the strands Model via .structured_output() - no Strands Agent, no
tools, no conversation loop. See control_tower.py's module docstring for
why that pattern is used instead of an Agent.
"""

from __future__ import annotations

import asyncio
import json

from pydantic import BaseModel, Field
from strands.types.content import Message

from backend_client import NotFound, get_backend_client
from config.settings import settings
from tools.mocks.supplier_mock_data import SupplierNotFoundError
from tools.schemas.supplier_schema import SupplierNarration, SupplierStats

SUPPLIER_NARRATION_SYSTEM_PROMPT = """\
You write short, plain-language supplier analyses for procurement staff \
who are deciding whether to use, continue using, or switch away from a \
supplier - no jargon, no internal field names, no code-like language. \
Given one supplier's stats, produce exactly two things:

1. narrative: 2-4 plain sentences explaining this supplier's real \
strengths and weaknesses. Concretely trade cost, lead time, and \
reliability off against each other rather than listing the numbers in \
isolation - e.g. explain that a lower price may come with a longer lead \
time or a weaker delivery record, or that a fast and reliable supplier \
commands a premium.

2. recommendation_context: 1-3 sentences of CONTEXT for the reader's own \
decision - how this supplier's profile compares to what a strong supplier \
profile generally looks like, and what kind of situation it suits well or \
poorly (e.g. reliable-but-slow suits planned restocking, not an urgent \
order). This is context, not a verdict - never tell the reader outright \
what to do ("choose this supplier", "drop them", "switch to a competitor") \
- help them weigh it themselves.

Hard rules:
- NEVER INVENT FACTS. State only what the supplier stats given to you
  actually contain. Do not invent other suppliers to compare against,
  specific competitor numbers, or history/claims about this supplier that
  aren't in the data you were given.
- This is informative context for a human procurement decision, not an
  instruction - never phrase either field as a command or a final,
  unilateral verdict.
- Plain business language only. Translate field names instead of quoting
  them - "reliability_score: 0.97" becomes something like "a strong
  on-time delivery record," not "a reliability_score of 0.97."
"""


class _NarrationFields(BaseModel):
    """Only what the model actually generates - see narrate_supplier().

    Deliberately NOT the same model as SupplierNarration: the model must
    never regenerate the supplier's stats, only add narrative and
    recommendation_context to values we already have.
    """

    narrative: str = Field(..., description="Plain-language explanation of this supplier's trade-offs.")
    recommendation_context: str = Field(
        ..., description="Context comparing this supplier to a strong profile - never a directive."
    )


async def _fetch_supplier_stats(supplier_id: int) -> SupplierStats:
    """Compose two real backend endpoints into this AI layer's SupplierStats shape.

    GET /suppliers/{id}/transactions (SuppliersService.getTransactionHistory())
    is both the existence check and the source of name/leadTimeDays/
    product_categories in one call - it 404s for an unknown id via its own
    findOne() call (see suppliers.service.ts), so a real NotFound here means
    a real unknown supplier, not a system failure.

    GET /supplier-intelligence/{id}/stats (SupplierIntelligenceService.
    getSupplierStats()) supplies the transaction-derived quality metrics -
    the same real endpoint agents/insights_agent/tools.py's
    compare_suppliers() already relies on for supplier data, just scoped to
    ALL of this supplier's history instead of one product's.

    Raises:
        SupplierNotFoundError: If supplier_id doesn't match a real supplier.
    """
    client = get_backend_client()

    try:
        history = await client.get(f"/suppliers/{supplier_id}/transactions")
    except NotFound as exc:
        raise SupplierNotFoundError(
            f"No supplier found for supplier_id={supplier_id!r}. "
            "Do not guess or fabricate a supplier_id - it must come from a "
            "real supplier record or from the user."
        ) from exc

    stats = await client.get(f"/supplier-intelligence/{supplier_id}/stats")

    product_categories = sorted(
        {
            item["product"]["category"]
            for transaction in history.get("transactions", [])
            for item in transaction.get("items", [])
            if item.get("product", {}).get("category")
        }
    )

    # The real backend computes exactly one on-time-delivery metric for a
    # supplier outside a specific product's ranking - reliability_score
    # mirrors it rather than inventing a second, independently-derived
    # number the backend doesn't produce.
    on_time_delivery_rate = stats["onTimeDeliveryRate"]

    return SupplierStats.model_validate(
        {
            "supplier_id": supplier_id,
            "name": history["name"],
            "unit_cost": stats["averagePrice"],
            "lead_time_days": history["leadTimeDays"],
            "reliability_score": on_time_delivery_rate,
            # No real backend endpoint computes a composite quality score
            # for a supplier outside a specific product's ranking (see
            # SupplierIntelligenceService.rankSuppliers(), which is
            # product-scoped) - left unset rather than fabricated or
            # averaged across products, which would be new scoring logic.
            "overall_score": None,
            "recent_transaction_count": stats["totalTransactions"],
            "on_time_delivery_rate": on_time_delivery_rate,
            "product_categories": product_categories,
        }
    )


def narrate_supplier(supplier_id: str) -> SupplierNarration:
    """Narrate one supplier's real stats into plain language, on demand.

    Makes ONE direct, non-tool-calling call to the strands Model returned
    by settings.build_model("narration") - the same model tier as the
    Control Tower batch narration layer, since both are single-purpose
    narration calls with no need for a bigger/more expensive model.

    Args:
        supplier_id: The supplier's database ID, as a string (e.g. from a
            CLI argument or an API request) - converted to int internally.

    Returns:
        A SupplierNarration carrying every field from the supplier's real
        stats unchanged, plus the generated narrative and
        recommendation_context.

    Raises:
        ValueError: If supplier_id isn't a valid integer.
        SupplierNotFoundError: If supplier_id doesn't match a known
            supplier - never falls back to a fabricated result.
    """
    try:
        numeric_id = int(supplier_id)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"supplier_id must be a numeric ID, got {supplier_id!r}") from exc

    stats: SupplierStats = asyncio.run(_fetch_supplier_stats(numeric_id))

    model = settings.build_model("narration")

    stats_json = json.dumps(stats.model_dump(), default=str)
    user_prompt = f"Supplier stats: {stats_json}\n\nWrite the narrative and recommendation_context for this supplier."
    messages: list[Message] = [{"role": "user", "content": [{"text": user_prompt}]}]

    async def _call() -> _NarrationFields:
        last_event: dict | None = None
        async for event in model.structured_output(
            _NarrationFields, messages, system_prompt=SUPPLIER_NARRATION_SYSTEM_PROMPT
        ):
            last_event = event
        if not last_event or "output" not in last_event:
            raise RuntimeError(
                f"Supplier narration model call for supplier_id={numeric_id!r} produced no structured output."
            )
        return last_event["output"]

    fields = asyncio.run(_call())

    return SupplierNarration(
        **stats.model_dump(),
        narrative=fields.narrative,
        recommendation_context=fields.recommendation_context,
    )
