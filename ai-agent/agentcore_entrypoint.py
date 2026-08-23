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
"openai", "ollama", or "bedrock" - completely independent of whether the
deploying AWS account/role even has Bedrock model-invoke permissions. Only
actually calling Bedrock (MODEL_PROVIDER=bedrock) needs those permissions;
the AgentCore Runtime *hosting* layer itself does not.

Local test (per the official guide's manual verification steps - see
README.md "Deploying to AgentCore Runtime" for the full walkthrough):

    python agentcore_entrypoint.py
    # in another terminal:
    curl -X POST http://localhost:8080/invocations \\
        -H "Content-Type: application/json" \\
        -H "Authorization: Bearer <human-cognito-access-token>" \\
        -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: erp-user-7-<uuid-hex>" \\
        -d '{"prompt": "Which products are at risk of stocking out?"}'
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from agentcore_memory import build_agentcore_memory_session_manager
from agents.supervisor.agent import build_supervisor_agent
from agents.supervisor.gate import is_in_scope
from agentcore_session import parse_runtime_session_owner
from backend_client import Forbidden, HumanAuthenticatedBackendClient, Unauthorized
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


@app.entrypoint
def invoke(payload: object, context: object) -> dict:
    """AgentCore Runtime entrypoint - one HTTP invocation in, one JSON response out.

    Uses context.session_id as conversation affinity, verifies its owner
    namespace against the ERP identity returned by /auth/me, and lazily reuses
    one Supervisor instance per session. The per-session lock protects mutable
    Strands conversation state without serializing unrelated sessions.

    Args:
        payload: The raw JSON request body. Must contain a "prompt" key
            with the user's query as a string.
        context: AgentCore request context. Its Authorization bearer value,
            when present, is scoped to this invocation as the human identity.

    Returns:
        {"result": <the Supervisor's text response>} - either the
        Supervisor's real answer, or the gate's decline message if the
        prompt was out of scope.

    Raises:
        ValueError: If payload has no usable "prompt" string. The
            AgentCore framework catches this and returns it as a 500 with
            the error message - see bedrock_agentcore.runtime.app for that
            handling.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")

    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('payload must contain a non-empty "prompt" string')
    prompt = prompt.strip()

    session_id = _runtime_session_id(context)

    bearer_token = _human_bearer_token(context)
    profile = asyncio.run(_validate_human_erp_membership(bearer_token))
    owner_erp_user_id = _erp_user_identity(profile)
    _validate_session_owner(session_id, owner_erp_user_id)
    state = _acquire_session_state(session_id, owner_erp_user_id)

    try:
        with state.invocation_lock:
            allowed, reason = is_in_scope(prompt)
            if not allowed:
                return {
                    "result": (
                        "I can only help with inventory, warehouses, orders, invoices, "
                        "stock, suppliers, and document processing for this ERP system "
                        f"({reason}). Let me know if you have a question in that area."
                    )
                }

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

            with human_auth_scope(bearer_token):
                response = state.supervisor_agent(prompt)
            return {"result": str(response)}
    finally:
        _release_session_state(state)


if __name__ == "__main__":
    app.run()
