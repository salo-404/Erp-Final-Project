"""AWS Bedrock AgentCore Runtime entrypoint for the Supervisor agent.

This is Option A (SDK Integration) from Strands' official AgentCore
deployment guide: BedrockAgentCoreApp wraps the EXISTING Supervisor agent
(agents/supervisor/agent.py) as an HTTP service. No new agent, no new agent
logic - this file only adds a deployment shell around
build_supervisor_agent(), which already works today via
scripts/chat_locally.py for local, interactive use.

Separate from scripts/chat_locally.py: that's a stdin/stdout REPL for local
development only. This module is what actually gets deployed to AgentCore
Runtime - an HTTP service speaking the AgentCore invocation protocol
(POST /invocations), not a terminal chat loop.

Model-agnostic by construction: build_supervisor_agent() already resolves
its model via settings.build_model("supervisor") (see config/settings.py),
so this entrypoint works with whichever MODEL_PROVIDER is set in .env -
"openai" or "bedrock" - completely independent of whether the deploying
AWS account/role even has Bedrock model-invoke permissions. Only actually
calling Bedrock (MODEL_PROVIDER=bedrock) needs those permissions; the
AgentCore Runtime *hosting* layer itself does not.

Local test (per the official guide's manual verification steps - see
README.md "Deploying to AgentCore Runtime" for the full walkthrough):

    python agentcore_entrypoint.py
    # in another terminal:
    curl -N -X POST http://localhost:8080/invocations \\
        -H "Content-Type: application/json" \\
        -H "Accept: text/event-stream" \\
        -H "Authorization: Bearer <human-cognito-access-token>" \\
        -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: erp-user-7-<uuid-hex>" \\
        -d '{"prompt": "Which products are at risk of stocking out?"}'
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from agentcore_memory import build_agentcore_memory_session_manager
from agents.supervisor.agent import build_supervisor_agent
from agents.supervisor.gate import is_in_scope
from agentcore_session import parse_runtime_session_owner
from backend_client import Forbidden, HumanAuthenticatedBackendClient, Unauthorized
from narration.control_tower_recommendation import build_recommendation
from request_context import human_auth_scope

app = BedrockAgentCoreApp()

# AgentCore normally gives one runtimeSessionId its own runtime/microVM. This
# bounded registry additionally keeps local tests and any process that sees
# multiple sessions safe: each session owns one mutable Supervisor and one
# invocation lock. The canonical session ID independently carries a non-secret
# ERP-user namespace, so ownership can be revalidated after process memory is
# lost. Locks and live Supervisor instances remain intentionally in-process.
_SESSION_IDLE_TTL_SECONDS = 60 * 60
_MAX_CACHED_SESSIONS = 256
_SESSION_LOCK_POLL_SECONDS = 0.01
_STREAM_ERROR_MESSAGE = "The assistant could not complete this request."


@dataclass
class _SessionState:
    owner_erp_user_id: str
    supervisor_agent: Any | None = None
    invocation_lock: threading.Lock = field(default_factory=threading.Lock)
    last_access: float = field(default_factory=time.monotonic)
    active_invocations: int = 0


_session_states: dict[str, _SessionState] = {}
_session_registry_lock = threading.Lock()


def _runtime_session_id(context: object) -> str:
    """Return AgentCore's authoritative runtime session ID."""
    session_id = getattr(context, "session_id", None)
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("AgentCore runtime context must provide a non-empty session ID")
    return session_id.strip()


def _human_bearer_token(context: object) -> str | None:
    """Extract a human bearer token from AgentCore's request headers."""
    headers = getattr(context, "request_headers", None) or {}
    authorization = next(
        (value for key, value in headers.items() if key.lower() == "authorization"),
        None,
    )
    if not isinstance(authorization, str):
        return None
    scheme, separator, token = authorization.strip().partition(" ")
    if separator and scheme.lower() == "bearer" and token.strip():
        return token.strip()
    return None


async def _validate_human_erp_membership(bearer_token: str | None) -> dict:
    """Require the Cognito caller to still map to an ERP User before any agent runs."""
    if not bearer_token:
        raise Unauthorized(401, "A human Cognito access token is required.")
    profile = await HumanAuthenticatedBackendClient(bearer_token).get("/auth/me")
    if not isinstance(profile, dict) or not profile.get("id"):
        raise Unauthorized(401, "The Cognito identity is not mapped to an ERP user.")
    return profile


def _erp_user_identity(profile: dict) -> str:
    """Extract the stable, non-secret ERP user identity returned by /auth/me."""
    user_id = profile.get("id")
    if isinstance(user_id, bool) or not isinstance(user_id, (int, str)):
        raise Unauthorized(401, "The Cognito identity is not mapped to an ERP user.")
    identity = str(user_id).strip()
    if not identity:
        raise Unauthorized(401, "The Cognito identity is not mapped to an ERP user.")
    return identity


def _validate_session_owner(session_id: str, owner_erp_user_id: str) -> None:
    """Match the session namespace to the already-authenticated ERP identity."""
    encoded_owner = parse_runtime_session_owner(session_id)
    if encoded_owner != owner_erp_user_id:
        raise Forbidden(
            403,
            "Runtime session ownership does not match the authenticated ERP user.",
        )


def _cleanup_sessions_locked(now: float) -> None:
    """Remove sessions that exceeded the idle lifetime while inactive."""
    stale_session_ids = [
        session_id
        for session_id, state in _session_states.items()
        if state.active_invocations == 0
        and now - state.last_access >= _SESSION_IDLE_TTL_SECONDS
    ]
    for session_id in stale_session_ids:
        del _session_states[session_id]


def _make_room_for_new_session_locked() -> None:
    """Evict the oldest inactive entries only when inserting a new session."""
    if len(_session_states) < _MAX_CACHED_SESSIONS:
        return

    inactive_by_age = sorted(
        (
            (session_id, state)
            for session_id, state in _session_states.items()
            if state.active_invocations == 0
        ),
        key=lambda item: item[1].last_access,
    )
    for session_id, _state in inactive_by_age:
        if len(_session_states) < _MAX_CACHED_SESSIONS:
            break
        del _session_states[session_id]


def _acquire_session_state(session_id: str, owner_erp_user_id: str) -> _SessionState:
    """Bind or verify ownership and mark the session active."""
    now = time.monotonic()
    with _session_registry_lock:
        _cleanup_sessions_locked(now)
        state = _session_states.get(session_id)
        if state is None:
            _make_room_for_new_session_locked()
            state = _SessionState(owner_erp_user_id=owner_erp_user_id)
            _session_states[session_id] = state
        elif state.owner_erp_user_id != owner_erp_user_id:
            raise Forbidden(
                403,
                "This runtime session belongs to a different authenticated ERP user.",
            )

        state.active_invocations += 1
        state.last_access = now
        return state


def _release_session_state(state: _SessionState) -> None:
    with _session_registry_lock:
        state.active_invocations = max(0, state.active_invocations - 1)
        state.last_access = time.monotonic()


async def _acquire_invocation_lock(lock: threading.Lock) -> None:
    """Acquire a session lock without blocking the async worker or leaking on cancellation."""
    while not lock.acquire(blocking=False):
        await asyncio.sleep(_SESSION_LOCK_POLL_SECONDS)



# Friendly, non-technical labels for tool calls a user might see while
# waiting — never the raw function name (Supervisor's hardened prompt
# already resists revealing internal architecture to adversarial input;
# this keeps that same spirit for the ordinary status line too). Covers
# every tool actually registered on Supervisor/Insights/Document (see
# agents/*/agent.py's *_TOOLS lists) plus the two Supervisor-level
# specialist calls themselves.
_TOOL_STATUS_LABELS: dict[str, str] = {
    "insights_agent_tool": "Checking inventory and analytics...",
    "document_agent_tool": "Processing the document...",
    "get_available_stock": "Checking available stock...",
    "recommend_fulfillment_warehouse": "Finding the best fulfillment warehouse...",
    "get_low_stock_products": "Checking low-stock products...",
    "get_stockout_risk": "Assessing stockout risk...",
    "get_restock_recommendations": "Working out restock recommendations...",
    "get_transfer_recommendations": "Looking for transfer opportunities...",
    "analyze_dead_stock": "Analyzing dead stock...",
    "get_consumption_anomalies": "Checking for consumption anomalies...",
    "compare_suppliers": "Comparing suppliers...",
    "get_open_purchase_orders": "Checking open purchase orders...",
    "query_database": "Querying the database...",
    "get_pending_document_reviews": "Checking pending document reviews...",
    "get_document_review": "Looking up the document...",
    "resolve_document_product": "Matching the product...",
    "resolve_document_supplier": "Matching the supplier...",
    "approve_document_review": "Approving the document...",
    "reject_document_review": "Rejecting the document...",
    "detect_duplicate_document": "Checking for duplicate documents...",
    "recommend_dead_stock_transfer": "Checking dead stock transfer options...",
    "recommend_stockout_fix": "Checking transfer and supplier options...",
    "recommend_alternative_supplier": "Comparing alternative suppliers...",
}

# The only "mode" values invoke() accepts besides the default (absent/None,
# ordinary Supervisor-routed chat) - see build_control_tower_recommendation_agent()'s
# module docstring for why this rides the same /invocations path instead of
# a second HTTP route.
_MODE_CONTROL_TOWER_RECOMMENDATION = "control_tower_recommendation"


def _humanize_tool_name(name: str) -> str:
    """Mechanical fallback for a tool with no entry above — a readable
    rendering of its real name, never an invented description (e.g.
    "get_open_purchase_orders" -> "Get open purchase orders..."). Only
    reached for a tool added later that this label table hasn't caught up
    with yet.
    """
    words = name.replace("_", " ").strip()
    if not words:
        return "Working..."
    return f"{words[0].upper()}{words[1:]}..."


def _public_tool_status(event: object) -> dict[str, str] | None:
    """A tool-use-start event, rendered as a friendly live status line —
    the one piece of otherwise-internal Strands event data that's safe and
    useful to surface, unlike reasoning/tool-result content (still fully
    suppressed by _public_text_delta below).
    """
    if not isinstance(event, dict):
        return None
    tool_use = event.get("current_tool_use")
    if not isinstance(tool_use, dict):
        return None
    name = tool_use.get("name")
    if not isinstance(name, str) or not name:
        return None
    label = _TOOL_STATUS_LABELS.get(name) or _humanize_tool_name(name)
    return {"type": "tool_status", "label": label}


_GATE_CONTEXT_TURNS = 2  # user+assistant pairs - enough to recognize a follow-up, not a full transcript


def _recent_conversation_context(agent: Any | None) -> str | None:
    """Serialize the tail of an existing Supervisor's conversation for the gate.

    Returns None when there's no prior conversation yet (a session's first
    message, or a session whose Supervisor hasn't been built) - the gate
    then falls back to judging the message in isolation, which is correct
    for a genuinely first message. See gate.is_in_scope's docstring for why
    this exists: without it, an ordinary follow-up with no ERP keyword of
    its own gets declined by a classifier that never sees what it's
    following up on.
    """
    if agent is None:
        return None
    messages = getattr(agent, "messages", None)
    if not messages:
        return None

    lines: list[str] = []
    for message in messages[-(_GATE_CONTEXT_TURNS * 2):]:
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue
        text_parts = [
            block["text"]
            for block in message.get("content", [])
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        text = " ".join(text_parts).strip()
        if text:
            lines.append(f"{role}: {text}")

    return "\n".join(lines) if lines else None


def _public_text_delta(event: object) -> dict[str, str] | None:
    """Return the only public form of a safe Strands text-stream event."""
    if not isinstance(event, dict):
        return None
    text = event.get("data")
    if not isinstance(text, str) or not text:
        return None
    if "type" in event or event.get("reasoning") is True or any(
        internal_key in event
        for internal_key in (
            "current_tool_use",
            "tool_result",
            "tool_stream_event",
            "reasoningText",
            "reasoningRedactedContent",
            "reasoning_signature",
        )
    ):
        return None
    return {"type": "text_delta", "text": text}


async def _stream_agent_events(agent: Any, prompt: str, bearer_token: str | None) -> AsyncIterator[dict[str, str]]:
    """Stream one agent's response as the safe public tool_status/text_delta
    event shape - no "done"/"error" (callers add those, since the normal
    chat path and the Control Tower recommendation mode below wrap this
    differently around it). Shared so both paths get the exact same event
    translation and the exact same stream-close-on-exit behavior, rather
    than two copies that could quietly drift apart.
    """
    with human_auth_scope(bearer_token):
        agent_stream = agent.stream_async(prompt)
        try:
            async for event in agent_stream:
                tool_status = _public_tool_status(event)
                if tool_status is not None:
                    yield tool_status
                    continue
                public_event = _public_text_delta(event)
                if public_event is not None:
                    yield public_event
        finally:
            close_stream = getattr(agent_stream, "aclose", None)
            if callable(close_stream):
                await close_stream()


@app.entrypoint
async def invoke(payload: object, context: object) -> AsyncIterator[dict[str, str]]:
    """Validate one invocation and return its normalized public SSE event stream.

    Uses context.session_id as conversation affinity, verifies its owner
    namespace against the ERP identity returned by /auth/me, and lazily reuses
    one Supervisor instance per session. The per-session lock protects mutable
    Strands conversation state without serializing unrelated sessions.

    Args:
        payload: The raw JSON request body. Must contain a "prompt" key as
            a string. May optionally contain a "mode" key - absent/None
            for ordinary Supervisor-routed chat, where "prompt" is the
            user's natural-language query; or "control_tower_recommendation"
            to route to the deterministic Control Tower recommendation
            builder instead (see narration/control_tower_recommendation.py),
            where "prompt" is instead a JSON-encoded object shaped
            {"category": "DEAD_STOCK"|"STOCKOUT_RISK"|"OVERDUE_TRANSACTION",
            ...the category's real IDs - see build_recommendation()'s
            docstring for the exact per-category shape}. Still the same
            /invocations path and the same auth/session-ownership checks
            either way. Any other "mode" value is rejected.
        context: AgentCore request context. Its Authorization bearer value,
            when present, is scoped to this invocation as the human identity.

    Returns:
        An async iterator of safe ``text_delta``, ``tool_status``, ``done``,
        or ``error`` objects. BedrockAgentCoreApp serializes these objects
        as SSE.

    Raises:
        ValueError: If payload has no usable "prompt" string, or "mode" is
            present but not a recognized value. The AgentCore framework
            catches this and returns it as a 500 with the error message -
            see bedrock_agentcore.runtime.app for that handling.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")

    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('payload must contain a non-empty "prompt" string')
    prompt = prompt.strip()

    mode = payload.get("mode")
    if mode is not None and mode != _MODE_CONTROL_TOWER_RECOMMENDATION:
        raise ValueError(f'Unrecognized "mode": {mode!r}')

    session_id = _runtime_session_id(context)

    bearer_token = _human_bearer_token(context)
    profile = await _validate_human_erp_membership(bearer_token)
    owner_erp_user_id = _erp_user_identity(profile)
    _validate_session_owner(session_id, owner_erp_user_id)

    if mode == _MODE_CONTROL_TOWER_RECOMMENDATION:
        # No session caching/locking here (unlike the normal chat path
        # below) - deliberately, not an oversight. Each Control Tower
        # click already mints its own fresh, single-use session ID (see
        # frontend/src/components/control-tower/RecommendSolutionAction.tsx),
        # so nothing would ever be reused across requests anyway, and
        # there is no multi-turn conversation here to protect with a lock.
        # The scope gate is also deliberately skipped: "prompt" here is a
        # JSON-encoded alert description, not free user text, and
        # build_recommendation()'s only backend access is the same narrow,
        # read-only tool calls Insights already exposes to this same
        # authenticated user - see narration/control_tower_recommendation.py.
        async def stream_recommendation() -> AsyncIterator[dict[str, str]]:
            try:
                alert = json.loads(prompt)
                if not isinstance(alert, dict) or not isinstance(alert.get("category"), str):
                    raise ValueError('"prompt" must be a JSON object with a "category" string')
                category = alert.pop("category")
                text = await build_recommendation(category, alert)
                yield {"type": "text_delta", "text": text}
                yield {"type": "done"}
            except asyncio.CancelledError:
                raise
            except Exception:
                yield {"type": "error", "message": _STREAM_ERROR_MESSAGE}

        return stream_recommendation()

    async def stream_response() -> AsyncIterator[dict[str, str]]:
        state = _acquire_session_state(session_id, owner_erp_user_id)
        lock_acquired = False
        agent_stream: object | None = None
        try:
            await _acquire_invocation_lock(state.invocation_lock)
            lock_acquired = True

            # Only read context off a Supervisor this session ALREADY built on
            # an earlier turn - never construct Memory/Supervisor just to feed
            # the gate. A declined query must still never cause either to be
            # built (see test_gate_decline_uses_stream_contract_without_memory_or_supervisor).
            # This means a session's first message, or the first message after
            # a microVM reset drops the in-process cache, is judged without
            # context (same as before this fix) - the common case this fixes
            # is an ordinary follow-up later in an already-active session.
            recent_context = _recent_conversation_context(state.supervisor_agent)
            allowed, reason, internal_error = await asyncio.to_thread(
                is_in_scope, prompt, recent_context
            )
            if not allowed:
                # internal_error: reason is already the standalone generic
                # fallback message (see gate.is_in_scope) - never grafted
                # into the normal decline template below, and never
                # containing raw exception details.
                text = (
                    reason
                    if internal_error
                    else (
                        "I can only help with inventory, warehouses, orders, invoices, "
                        "stock, and suppliers for this ERP system "
                        f"({reason}). Let me know if you have a question in that area."
                    )
                )
                yield {"type": "text_delta", "text": text}
                yield {"type": "done"}
                return

            if state.supervisor_agent is None:
                memory_session_manager = build_agentcore_memory_session_manager(
                    actor_id=owner_erp_user_id,
                    session_id=session_id,
                )
                if memory_session_manager is None:
                    state.supervisor_agent = build_supervisor_agent()
                else:
                    state.supervisor_agent = build_supervisor_agent(
                        session_manager=memory_session_manager
                    )

            async for event in _stream_agent_events(state.supervisor_agent, prompt, bearer_token):
                yield event

            yield {"type": "done"}
        except asyncio.CancelledError:
            raise
        except Exception:
            yield {"type": "error", "message": _STREAM_ERROR_MESSAGE}
        finally:
            if lock_acquired:
                state.invocation_lock.release()
            _release_session_state(state)

    return stream_response()


if __name__ == "__main__":
    app.run()
