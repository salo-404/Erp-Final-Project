"""Control Tower narration layer.

Per the locked architecture doc, Control Tower is explicitly NOT a fourth
agent and NOT a live chat entry point - the system stays Supervisor +
Insights + Document (see the top-level README.md "Architecture - locked at
3 agents"). This module is a batch process: it fetches backend-generated
structured alerts from GET /control-tower/alerts, validates them, and turns
each alert's authoritative message/data into a plain-language narrative plus
one proposed action.

Deliberately NOT built as a Strands Agent with tools. An Agent brings a
tool registry, a multi-turn conversation loop, and conversation-management
overhead that this doesn't need - narration is one-shot per alert (read
evidence, produce two strings) and may run over many alerts in a batch, so
it calls the underlying strands Model directly via .structured_output(),
bypassing Agent/tool machinery entirely. Compare agents/supervisor/gate.py,
which uses a no-tools Agent for its classification call - narration goes
one level lighter still, since even a no-tools Agent carries loop overhead
this doesn't need.
"""

from __future__ import annotations

import asyncio
import json

from pydantic import BaseModel, Field, TypeAdapter
from strands.types.content import Message

from backend_client import get_backend_client
from config.settings import settings
from tools.schemas.control_tower_schema import Alert, NarratedAlert

NARRATION_SYSTEM_PROMPT = """\
You write short, plain-language alert narrations for warehouse and \
inventory operations staff - no jargon, no internal field names, no \
code-like language. Given one backend-generated alert, produce exactly two things:

1. narrative: 1-3 plain sentences explaining what the evidence means in \
business terms - what happened, why it matters, and to which product, \
warehouse, or document, when that's part of the evidence.

2. proposed_action: ONE concrete, specific next step, using the real \
names and numbers from the evidence - e.g. "Reorder 60 units of the \
USB-C Docking Station from Nordic Components AB" or "Review invoice \
doc_inv_2026_0815_001 for a quantity discrepancy on the USB-C Docking \
Station before approving payment." Never a vague action like "consider \
restocking" or "investigate further" when the evidence supports something \
more specific.

Hard rules:
- The backend-provided category, severity, message, data, and reference date
  are authoritative. Do not alter, reinterpret, upgrade, downgrade, or
  regenerate category or severity.
- NEVER INVENT FACTS. State only what the backend message and data actually
  contains. If the evidence doesn't include a particular number, name, or
  date, don't make one up or imply a precision you don't have.
- Any action you propose - reordering, transferring stock, approving or
  rejecting a document - is a PROPOSAL for a human to review and approve,
  never something already done. Phrase actions as instructions ("Reorder
  X", "Review Y"), never as completed events ("Reordered X", "Y was
  reviewed").
- Do not perform business calculations, create thresholds, recalculate alert
  state, or claim an email/notification was sent. Do not claim any proposed
  action was executed.
- Prefer the backend message and evidence. For DEAD_STOCK, customer demand is
  represented by lastOutgoingMovementAt/daysSinceLastOutgoingMovement; generic
  lastMovementAt may include transfers, incoming stock, or adjustments and
  must not be described as customer demand. For OVERDUE_TRANSACTION, accept
  the backend classification and dates without independently deciding whether
  it is overdue.
- PENDING_DOCUMENT_REVIEW is read-only and informational. You may propose that
  an ADMIN review it, but never approve, reject, or recommend a decision that
  the backend evidence does not support.
- Preserve backend recommendedQuantity/reason and transferQuantity/source/
  destination evidence exactly. Never calculate a different recommendation.
- Plain business language only. Translate field names instead of quoting
  them - "productId: 108" becomes "the Mechanical Keyboard", not
  "product 108" or "productId 108", when a product name is available in
  the evidence.
"""


class _NarrationFields(BaseModel):
    """Only what the model actually generates - see narrate_alert().

    Deliberately NOT the same model as NarratedAlert: the model only adds
    narrative and proposed_action to authoritative backend values.
    """

    narrative: str = Field(..., description="Plain-language explanation of the alert - no jargon.")
    proposed_action: str = Field(..., description="One concrete recommended next step, phrased as a proposal.")


def narrate_alert(alert: Alert) -> NarratedAlert:
    """Narrate a single alert into plain language plus one proposed action.

    Makes ONE direct, non-tool-calling call to the strands Model returned
    by settings.build_model("narration") - not a Strands Agent, no tools,
    no conversation loop. Intentionally the lightest-weight call in this
    codebase, since narrate_all_alerts() may run this over many alerts.

    Args:
        alert: The structured alert to narrate.

    Returns:
        A NarratedAlert carrying every field from `alert` unchanged, plus
        the generated narrative and proposed_action.
    """
    model = settings.build_model("narration")

    data_json = json.dumps(alert.data, default=str)
    user_prompt = (
        f"Alert category: {alert.category.value}\n"
        f"Severity: {alert.severity.value}\n"
        f"Backend message: {alert.message}\n"
        f"Reference date: {alert.referenceDate.isoformat()}\n"
        f"Evidence data: {data_json}\n\n"
        "Write the narrative and proposed_action for this alert."
    )
    messages: list[Message] = [{"role": "user", "content": [{"text": user_prompt}]}]

    async def _call() -> _NarrationFields:
        last_event: dict | None = None
        async for event in model.structured_output(
            _NarrationFields, messages, system_prompt=NARRATION_SYSTEM_PROMPT
        ):
            last_event = event
        if not last_event or "output" not in last_event:
            raise RuntimeError(
                "Narration model call for "
                f"{alert.category.value}/{alert.referenceDate.isoformat()} produced no structured output."
            )
        return last_event["output"]

    fields = asyncio.run(_call())

    return NarratedAlert(
        **alert.model_dump(),
        narrative=fields.narrative,
        proposed_action=fields.proposed_action,
    )


def narrate_all_alerts(alerts: list[Alert]) -> list[NarratedAlert]:
    """Batch entry point: narrate every alert in `alerts`, in order.

    Simple sequential loop over narrate_alert() - not parallelized. This is
    a batch/offline process, not a latency-sensitive live path, so simple
    beats fast here. See scripts/run_control_tower_narration.py for a
    manual run against the real backend alert feed.

    Args:
        alerts: Validated alerts returned by fetch_control_tower_alerts().

    Returns:
        One NarratedAlert per input alert, in the same order.
    """
    return [narrate_alert(alert) for alert in alerts]


async def fetch_control_tower_alerts() -> list[Alert]:
    """Fetch and validate the authenticated backend Control Tower feed.

    Uses the shared service-user BackendClient, including its token cache and
    one-time 401 refresh. Backend and validation failures propagate; there is
    deliberately no mock or fallback alert source.
    """
    raw_alerts = await get_backend_client().get("/control-tower/alerts")
    return TypeAdapter(list[Alert]).validate_python(raw_alerts)
