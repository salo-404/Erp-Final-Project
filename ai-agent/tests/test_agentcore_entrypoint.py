from __future__ import annotations

import asyncio
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

import agentcore_entrypoint as entrypoint
from agentcore_session import build_runtime_session_id, parse_runtime_session_owner
from backend_client import Forbidden, Unauthorized
from request_context import get_human_bearer_token

_ASYNC_INVOKE = entrypoint.invoke


async def _collect_stream(payload: object, context: object) -> list[dict[str, str]]:
    stream = await _ASYNC_INVOKE(payload, context)
    return [event async for event in stream]


def _sync_invoke(payload: object, context: object) -> dict[str, str]:
    events = asyncio.run(_collect_stream(payload, context))
    return {
        "result": "".join(
            event["text"] for event in events if event.get("type") == "text_delta"
        )
    }


@pytest.fixture(autouse=True)
def reset_session_registry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(entrypoint, "invoke", _sync_invoke)
    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()
    yield
    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()


def _context(session_id: object, bearer: str | None = "human-token") -> object:
    headers = {} if bearer is None else {"authorization": f"Bearer {bearer}"}
    return SimpleNamespace(session_id=session_id, request_headers=headers)


def _session(owner: int, marker: str = "a") -> str:
    return f"erp-user-{owner}-{marker * 32}"


def _patch_membership(
    monkeypatch: pytest.MonkeyPatch,
    identities: dict[str, int],
    calls: list[str] | None = None,
) -> None:
    async def validate(token: str | None) -> dict:
        if calls is not None:
            calls.append(str(token))
        if token not in identities:
            raise Unauthorized(401, "ERP identity validation failed.")
        return {"id": identities[token], "role": "EMPLOYEE"}

    monkeypatch.setattr(entrypoint, "_validate_human_erp_membership", validate)


class RecordingAgent:
    def __init__(self, *, fail: bool = False, delay: float = 0.0) -> None:
        self.fail = fail
        self.delay = delay
        self.prompts: list[str] = []
        self.bearers: list[str | None] = []
        self._counter_lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    async def stream_async(self, prompt: str):
        with self._counter_lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            self.prompts.append(prompt)
            self.bearers.append(get_human_bearer_token())
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.fail:
                raise RuntimeError("supervisor failed")
            yield {"data": f"answer:{prompt}", "delta": {"text": f"answer:{prompt}"}}
        finally:
            with self._counter_lock:
                self.active -= 1


def _allow_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))


def test_human_bearer_token_extraction_is_case_insensitive() -> None:
    context = SimpleNamespace(request_headers={"authorization": "Bearer human-token"})
    assert entrypoint._human_bearer_token(context) == "human-token"


def test_agentcore_membership_validation_calls_auth_me_with_human_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, str]] = []

    class FakeHumanClient:
        def __init__(self, token: str) -> None:
            self.token = token

        async def get(self, path: str) -> dict:
            requests.append((self.token, path))
            return {"id": 7, "email": "human@example.com", "role": "EMPLOYEE"}

    monkeypatch.setattr(entrypoint, "HumanAuthenticatedBackendClient", FakeHumanClient)
    profile = asyncio.run(entrypoint._validate_human_erp_membership("human-token"))

    assert profile["id"] == 7
    assert requests == [("human-token", "/auth/me")]


def test_context_session_and_auth_me_identity_override_payload_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_calls: list[str] = []
    _patch_membership(monkeypatch, {"user-seven-token": 7}, auth_calls)
    _allow_scope(monkeypatch)
    agent = RecordingAgent()
    monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: agent)

    entrypoint.invoke(
        {
            "prompt": "Show inventory",
            "userId": 999,
            "sessionId": "payload-session",
            "conversationId": "payload-conversation",
        },
        _context(_session(7), "user-seven-token"),
    )

    assert auth_calls == ["user-seven-token"]
    assert set(entrypoint._session_states) == {_session(7)}
    assert entrypoint._session_states[_session(7)].owner_erp_user_id == "7"


def test_auth_me_runs_on_every_invocation_and_same_session_reuses_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_calls: list[str] = []
    _patch_membership(monkeypatch, {"same-user": 7}, auth_calls)
    _allow_scope(monkeypatch)
    built: list[RecordingAgent] = []

    def build() -> RecordingAgent:
        agent = RecordingAgent()
        built.append(agent)
        return agent

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build)

    entrypoint.invoke({"prompt": "First"}, _context(_session(7), "same-user"))
    entrypoint.invoke({"prompt": "Follow up"}, _context(_session(7), "same-user"))

    assert auth_calls == ["same-user", "same-user"]
    assert len(built) == 1
    assert built[0].prompts == ["First", "Follow up"]


def test_same_user_different_sessions_have_independent_agents_and_histories(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-user": 7})
    _allow_scope(monkeypatch)
    built: list[RecordingAgent] = []

    def build() -> RecordingAgent:
        agent = RecordingAgent()
        built.append(agent)
        return agent

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build)

    entrypoint.invoke({"prompt": "Product X"}, _context(_session(7, "a"), "same-user"))
    entrypoint.invoke(
        {"prompt": "Overdue incoming"}, _context(_session(7, "b"), "same-user")
    )
    entrypoint.invoke(
        {"prompt": "Which warehouse?"}, _context(_session(7, "a"), "same-user")
    )

    assert len(built) == 2
    assert built[0].prompts == ["Product X", "Which warehouse?"]
    assert built[1].prompts == ["Overdue incoming"]


def test_different_users_and_sessions_do_not_share_agent_or_bearer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-a": 1, "token-b": 2})
    _allow_scope(monkeypatch)
    built: list[RecordingAgent] = []

    def build() -> RecordingAgent:
        agent = RecordingAgent()
        built.append(agent)
        return agent

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build)

    entrypoint.invoke({"prompt": "User A"}, _context(_session(1), "token-a"))
    entrypoint.invoke({"prompt": "User B"}, _context(_session(2), "token-b"))

    assert len(built) == 2
    assert built[0].bearers == ["token-a"]
    assert built[1].bearers == ["token-b"]


def test_different_user_cannot_take_over_existing_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-a": 1, "token-b": 2})
    _allow_scope(monkeypatch)
    agent = RecordingAgent()
    monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: agent)

    session_id = _session(1)
    entrypoint.invoke({"prompt": "User A"}, _context(session_id, "token-a"))

    with pytest.raises(Forbidden, match="ownership does not match") as exc_info:
        entrypoint.invoke({"prompt": "User B"}, _context(session_id, "token-b"))

    assert agent.prompts == ["User A"]
    error_text = str(exc_info.value)
    for sensitive_value in (session_id, "token-a", "token-b"):
        assert sensitive_value not in error_text
    assert "ERP user 1" not in error_text
    assert "ERP user 2" not in error_text


def test_matching_canonical_session_owner_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-seven": 7})
    _allow_scope(monkeypatch)
    agent = RecordingAgent()
    monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: agent)

    result = entrypoint.invoke(
        {"prompt": "Show inventory"},
        _context(_session(7), "token-seven"),
    )

    assert result == {"result": "answer:Show inventory"}
    assert agent.prompts == ["Show inventory"]


def test_malformed_session_fails_after_auth_but_before_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_calls: list[str] = []
    _patch_membership(monkeypatch, {"human-token": 7}, auth_calls)
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: pytest.fail("Supervisor must not be built"),
    )
    malformed_session = "missing-owner-namespace-00000000000000000000000000000000"

    with pytest.raises(ValueError, match="required user-owned format") as exc_info:
        entrypoint.invoke(
            {"prompt": "Show inventory"},
            _context(malformed_session, "human-token"),
        )

    assert auth_calls == ["human-token"]
    assert entrypoint._session_states == {}
    assert malformed_session not in str(exc_info.value)
    assert "human-token" not in str(exc_info.value)


def test_payload_identity_cannot_override_session_owner_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-two": 2})
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: pytest.fail("Supervisor must not be built"),
    )

    with pytest.raises(Forbidden, match="ownership does not match"):
        entrypoint.invoke(
            {
                "prompt": "Show inventory",
                "userId": 1,
                "sessionId": _session(2),
                "conversationId": "payload-cannot-authorize",
            },
            _context(_session(1), "token-two"),
        )

    assert entrypoint._session_states == {}


def test_cross_user_session_reuse_fails_after_simulated_microvm_reset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-a": 1, "token-b": 2})
    _allow_scope(monkeypatch)
    built: list[RecordingAgent] = []

    def build() -> RecordingAgent:
        agent = RecordingAgent()
        built.append(agent)
        return agent

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build)
    session_id = _session(1)
    entrypoint.invoke({"prompt": "User A"}, _context(session_id, "token-a"))

    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()

    with pytest.raises(Forbidden, match="ownership does not match"):
        entrypoint.invoke({"prompt": "User B"}, _context(session_id, "token-b"))

    assert len(built) == 1
    assert built[0].prompts == ["User A"]
    assert entrypoint._session_states == {}


def test_same_user_session_resume_after_microvm_reset_builds_fresh_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-a": 1})
    _allow_scope(monkeypatch)
    built: list[RecordingAgent] = []

    def build() -> RecordingAgent:
        agent = RecordingAgent()
        built.append(agent)
        return agent

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build)
    session_id = _session(1)
    entrypoint.invoke({"prompt": "Before stop"}, _context(session_id, "token-a"))

    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()

    result = entrypoint.invoke(
        {"prompt": "After restart"}, _context(session_id, "token-a")
    )

    assert result == {"result": "answer:After restart"}
    assert len(built) == 2
    assert built[0].prompts == ["Before stop"]
    assert built[1].prompts == ["After restart"]


def test_active_process_owner_check_remains_defense_in_depth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-one": 1})
    session_id = _session(1)
    entrypoint._session_states[session_id] = entrypoint._SessionState(
        owner_erp_user_id="2"
    )
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: pytest.fail("Supervisor must not be built"),
    )

    with pytest.raises(Forbidden, match="different authenticated ERP user"):
        entrypoint.invoke(
            {"prompt": "Show inventory"}, _context(session_id, "token-one")
        )


def test_session_ids_are_unique_and_agentcore_compatible() -> None:
    first = build_runtime_session_id(7)
    second = build_runtime_session_id("7")

    assert first != second
    for session_id in (first, second):
        assert 33 <= len(session_id) <= 100
        assert re.fullmatch(r"[a-z0-9-]+", session_id)
        assert parse_runtime_session_owner(session_id) == "7"


@pytest.mark.parametrize(
    "session_id",
    [
        "erp-user-x-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "erp-user-0-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "erp-user-07-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "erp-user-7-not-a-uuid",
        "erp-user-7-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ],
)
def test_malformed_owner_or_conversation_namespace_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    session_id: str,
) -> None:
    _patch_membership(monkeypatch, {"token-seven": 7})
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: pytest.fail("Supervisor must not be built"),
    )

    with pytest.raises(ValueError, match="required user-owned format"):
        entrypoint.invoke(
            {"prompt": "Show inventory"}, _context(session_id, "token-seven")
        )

    assert entrypoint._session_states == {}


def test_supervisor_not_invoked_when_auth_me_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {})
    _allow_scope(monkeypatch)
    builds = {"count": 0}
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: builds.__setitem__("count", builds["count"] + 1),
    )

    with pytest.raises(Unauthorized):
        entrypoint.invoke(
            {"prompt": "Show inventory"},
            _context(_session(7), "invalid-token"),
        )

    assert builds["count"] == 0
    assert entrypoint._session_states == {}


def test_missing_bearer_is_rejected_before_session_binding_or_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: pytest.fail("Supervisor must not be built"),
    )

    with pytest.raises(Unauthorized, match="human Cognito access token"):
        entrypoint.invoke(
            {"prompt": "Show inventory"},
            _context(_session(7), None),
        )

    assert entrypoint._session_states == {}


def test_exact_human_bearer_is_scoped_and_resets_after_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"exact-human-token": 7})
    _allow_scope(monkeypatch)
    agent = RecordingAgent()
    monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: agent)

    entrypoint.invoke(
        {"prompt": "Approve review"},
        _context(_session(7), "exact-human-token"),
    )

    assert agent.bearers == ["exact-human-token"]
    assert get_human_bearer_token() is None


def test_human_bearer_resets_after_streaming_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"exact-human-token": 7})
    _allow_scope(monkeypatch)
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: RecordingAgent(fail=True),
    )

    result = entrypoint.invoke(
        {"prompt": "Approve review"},
        _context(_session(7), "exact-human-token"),
    )

    assert result == {"result": ""}
    assert get_human_bearer_token() is None
    assert entrypoint._session_states[_session(7)].active_invocations == 0


@pytest.mark.parametrize(
    "payload",
    [None, [], {}, {"prompt": None}, {"prompt": 42}, {"prompt": "   "}],
)
def test_malformed_prompt_is_rejected_before_auth_or_model(
    monkeypatch: pytest.MonkeyPatch,
    payload: object,
) -> None:
    auth_calls = {"count": 0}

    async def validate(token: str | None) -> dict:
        auth_calls["count"] += 1
        return {"id": 7}

    monkeypatch.setattr(entrypoint, "_validate_human_erp_membership", validate)
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda: pytest.fail("Supervisor must not be built"),
    )

    with pytest.raises(ValueError):
        entrypoint.invoke(payload, _context(_session(7)))

    assert auth_calls["count"] == 0


@pytest.mark.parametrize("session_id", [None, "", "   ", 123])
def test_missing_or_invalid_context_session_id_is_rejected_before_auth_and_model(
    monkeypatch: pytest.MonkeyPatch,
    session_id: object,
) -> None:
    auth_calls = {"count": 0}

    async def validate(token: str | None) -> dict:
        auth_calls["count"] += 1
        return {"id": 7}

    monkeypatch.setattr(entrypoint, "_validate_human_erp_membership", validate)

    with pytest.raises(ValueError, match="runtime context") as exc_info:
        entrypoint.invoke(
            {"prompt": "Show inventory", "sessionId": "payload-session"},
            _context(session_id),
        )

    assert auth_calls["count"] == 0
    assert "payload-session" not in str(exc_info.value)


def test_concurrent_same_session_invocations_are_serialized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-user": 7})
    _allow_scope(monkeypatch)
    agent = RecordingAgent(delay=0.05)
    monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: agent)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                entrypoint.invoke,
                {"prompt": prompt},
                _context(_session(7), "same-user"),
            )
            for prompt in ("one", "two")
        ]
        for future in futures:
            future.result(timeout=2)

    assert agent.max_active == 1
    assert sorted(agent.prompts) == ["one", "two"]


def test_different_sessions_are_not_serialized_by_one_global_invocation_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-user": 7})
    _allow_scope(monkeypatch)
    barrier = threading.Barrier(2)
    built: list[RecordingAgent] = []

    class BarrierAgent(RecordingAgent):
        async def stream_async(self, prompt: str):
            self.prompts.append(prompt)
            self.bearers.append(get_human_bearer_token())
            barrier.wait(timeout=1)
            yield {"data": f"answer:{prompt}", "delta": {"text": f"answer:{prompt}"}}

    def build() -> RecordingAgent:
        agent = BarrierAgent()
        built.append(agent)
        return agent

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            entrypoint.invoke,
            {"prompt": "A"},
            _context(_session(7, "a"), "same-user"),
        )
        second = executor.submit(
            entrypoint.invoke,
            {"prompt": "B"},
            _context(_session(7, "b"), "same-user"),
        )
        assert first.result(timeout=2)["result"] == "answer:A"
        assert second.result(timeout=2)["result"] == "answer:B"

    assert len(built) == 2


def test_concurrent_different_sessions_do_not_leak_human_bearers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"token-a": 1, "token-b": 2})
    _allow_scope(monkeypatch)
    barrier = threading.Barrier(2)
    observations: list[tuple[str, str | None]] = []
    observations_lock = threading.Lock()

    class BearerAgent:
        async def stream_async(self, prompt: str):
            barrier.wait(timeout=1)
            with observations_lock:
                observations.append((prompt, get_human_bearer_token()))
            yield {"data": "ok", "delta": {"text": "ok"}}

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", BearerAgent)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            entrypoint.invoke,
            {"prompt": "A"},
            _context(_session(1), "token-a"),
        )
        second = executor.submit(
            entrypoint.invoke,
            {"prompt": "B"},
            _context(_session(2), "token-b"),
        )
        first.result(timeout=2)
        second.result(timeout=2)

    assert set(observations) == {("A", "token-a"), ("B", "token-b")}
    assert get_human_bearer_token() is None


def test_idle_session_cleanup_does_not_remove_active_sessions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = time.monotonic()
    stale = entrypoint._SessionState(owner_erp_user_id="1", last_access=now - 100)
    active = entrypoint._SessionState(
        owner_erp_user_id="2",
        last_access=now - 100,
        active_invocations=1,
    )
    entrypoint._session_states.update({"stale": stale, "active": active})
    monkeypatch.setattr(entrypoint, "_SESSION_IDLE_TTL_SECONDS", 10)

    with entrypoint._session_registry_lock:
        entrypoint._cleanup_sessions_locked(now)

    assert "stale" not in entrypoint._session_states
    assert entrypoint._session_states["active"] is active


def test_capacity_cleanup_never_evicts_the_session_being_resumed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(entrypoint, "_MAX_CACHED_SESSIONS", 2)
    monkeypatch.setattr(entrypoint, "_SESSION_IDLE_TTL_SECONDS", float("inf"))
    first = entrypoint._SessionState(owner_erp_user_id="1", last_access=1)
    resumed = entrypoint._SessionState(owner_erp_user_id="2", last_access=2)
    entrypoint._session_states.update({"first": first, "resumed": resumed})

    state = entrypoint._acquire_session_state("resumed", "2")
    entrypoint._release_session_state(state)

    assert entrypoint._session_states == {"first": first, "resumed": resumed}


def test_new_session_evicts_oldest_inactive_entry_at_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(entrypoint, "_MAX_CACHED_SESSIONS", 2)
    monkeypatch.setattr(entrypoint, "_SESSION_IDLE_TTL_SECONDS", float("inf"))
    first = entrypoint._SessionState(owner_erp_user_id="1", last_access=1)
    second = entrypoint._SessionState(owner_erp_user_id="2", last_access=2)
    entrypoint._session_states.update({"first": first, "second": second})

    state = entrypoint._acquire_session_state("third", "3")
    entrypoint._release_session_state(state)

    assert "first" not in entrypoint._session_states
    assert set(entrypoint._session_states) == {"second", "third"}
