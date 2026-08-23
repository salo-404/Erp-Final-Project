from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

import agentcore_entrypoint as entrypoint
from backend_client import Unauthorized
from request_context import get_human_bearer_token


@pytest.fixture(autouse=True)
def reset_session_registry() -> None:
    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()
    yield
    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()


def _session(owner: int, marker: str = "a") -> str:
    return f"erp-user-{owner}-{marker * 32}"


def _context(session_id: str, bearer: str = "human-token") -> object:
    return SimpleNamespace(
        session_id=session_id,
        request_headers={"Authorization": f"Bearer {bearer}"},
    )


def _patch_membership(
    monkeypatch: pytest.MonkeyPatch, identities: dict[str, int]
) -> None:
    async def validate(token: str | None) -> dict:
        if token not in identities:
            raise Unauthorized(401, "ERP identity validation failed.")
        return {"id": identities[token], "role": "EMPLOYEE"}

    monkeypatch.setattr(entrypoint, "_validate_human_erp_membership", validate)


async def _collect(payload: object, context: object) -> list[dict[str, str]]:
    stream = await entrypoint.invoke(payload, context)
    return [event async for event in stream]


def test_only_safe_text_deltas_are_exposed_and_done_is_emitted_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"human-token": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", lambda **kwargs: None
    )

    class MixedEventAgent:
        async def stream_async(self, prompt: str):
            yield {"data": "Hello", "delta": {"text": "Hello"}}
            yield {"reasoningText": "private thought", "reasoning": True}
            yield {
                "data": "private reasoning",
                "delta": {"reasoningContent": {"text": "private reasoning"}},
                "reasoning": True,
            }
            yield {
                "type": "tool_use_stream",
                "data": "raw tool input",
                "current_tool_use": {"name": "query_database"},
            }
            yield {
                "type": "tool_stream",
                "tool_stream_event": {"data": "raw tool result"},
            }
            yield {"tool_result": {"content": "SELECT secret FROM Product"}}
            yield {"init_event_loop": True}
            yield {"result": "complete internal AgentResult"}
            yield {"data": " world", "delta": {"text": " world"}}

    monkeypatch.setattr(
        entrypoint, "build_supervisor_agent", lambda: MixedEventAgent()
    )

    events = asyncio.run(
        _collect({"prompt": "Show inventory"}, _context(_session(7)))
    )

    assert events == [
        {"type": "text_delta", "text": "Hello"},
        {"type": "text_delta", "text": " world"},
        {"type": "done"},
    ]
    assert sum(event == {"type": "done"} for event in events) == 1


def test_gate_decline_uses_stream_contract_without_memory_or_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"human-token": 7})
    monkeypatch.setattr(
        entrypoint, "is_in_scope", lambda prompt: (False, "out of scope")
    )
    monkeypatch.setattr(
        entrypoint,
        "build_agentcore_memory_session_manager",
        lambda **kwargs: pytest.fail("Memory must not be constructed"),
    )
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda **kwargs: pytest.fail("Supervisor must not be constructed"),
    )

    events = asyncio.run(_collect({"prompt": "Weather"}, _context(_session(7))))

    assert events[0]["type"] == "text_delta"
    assert "I can only help with inventory" in events[0]["text"]
    assert events[1] == {"type": "done"}


def test_same_session_is_serialized_for_the_full_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", lambda **kwargs: None
    )

    async def scenario() -> None:
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        calls: list[str] = []

        class SerializedAgent:
            async def stream_async(self, prompt: str):
                calls.append(prompt)
                if prompt == "first":
                    first_started.set()
                    await release_first.wait()
                yield {"data": prompt, "delta": {"text": prompt}}

        agent = SerializedAgent()
        monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: agent)
        context = _context(_session(7), "same-human")

        first = asyncio.create_task(_collect({"prompt": "first"}, context))
        await asyncio.wait_for(first_started.wait(), timeout=1)
        second = asyncio.create_task(_collect({"prompt": "second"}, context))
        await asyncio.sleep(0.05)
        assert calls == ["first"]

        release_first.set()
        first_events, second_events = await asyncio.gather(first, second)
        assert calls == ["first", "second"]
        assert first_events[-1] == {"type": "done"}
        assert second_events[-1] == {"type": "done"}

    asyncio.run(scenario())


def test_different_sessions_stream_concurrently(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", lambda **kwargs: None
    )

    async def scenario() -> None:
        both_started = asyncio.Event()
        release = asyncio.Event()
        active = 0
        max_active = 0

        class ConcurrentAgent:
            async def stream_async(self, prompt: str):
                nonlocal active, max_active
                active += 1
                max_active = max(max_active, active)
                if active == 2:
                    both_started.set()
                try:
                    await release.wait()
                    yield {"data": prompt, "delta": {"text": prompt}}
                finally:
                    active -= 1

        monkeypatch.setattr(
            entrypoint, "build_supervisor_agent", lambda: ConcurrentAgent()
        )
        first = asyncio.create_task(
            _collect(
                {"prompt": "first"}, _context(_session(7, "a"), "same-human")
            )
        )
        second = asyncio.create_task(
            _collect(
                {"prompt": "second"}, _context(_session(7, "b"), "same-human")
            )
        )
        await asyncio.wait_for(both_started.wait(), timeout=1)
        assert max_active == 2
        release.set()
        await asyncio.gather(first, second)

    asyncio.run(scenario())


def test_human_bearer_exists_for_full_stream_and_resets_after_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"exact-token": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", lambda **kwargs: None
    )
    observed: list[str | None] = []

    class BearerAgent:
        async def stream_async(self, prompt: str):
            observed.append(get_human_bearer_token())
            yield {"current_tool_use": {"name": "document_agent_tool"}}
            await asyncio.sleep(0)
            observed.append(get_human_bearer_token())
            yield {"data": "approved", "delta": {"text": "approved"}}

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: BearerAgent())

    events = asyncio.run(
        _collect(
            {"prompt": "Approve review"},
            _context(_session(7), "exact-token"),
        )
    )

    assert observed == ["exact-token", "exact-token"]
    assert events == [
        {"type": "text_delta", "text": "approved"},
        {"type": "done"},
    ]
    assert get_human_bearer_token() is None


def test_streaming_exception_is_safe_and_resets_context_and_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = "secret-human-token"
    _patch_membership(monkeypatch, {token: 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", lambda **kwargs: None
    )
    builds = 0

    class FailingAgent:
        async def stream_async(self, prompt: str):
            assert get_human_bearer_token() == token
            yield {"data": "partial", "delta": {"text": "partial"}}
            raise RuntimeError(
                f"internal SQL SELECT * FROM QueryExample; bearer={token}; credential=secret"
            )

    def build() -> FailingAgent:
        nonlocal builds
        builds += 1
        return FailingAgent()

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build)
    events = asyncio.run(
        _collect({"prompt": "Show inventory"}, _context(_session(7), token))
    )

    assert events == [
        {"type": "text_delta", "text": "partial"},
        {
            "type": "error",
            "message": "The assistant could not complete this request.",
        },
    ]
    public = json.dumps(events)
    for forbidden in (token, "credential=secret", "QueryExample", "SELECT *", "Traceback"):
        assert forbidden not in public
    assert builds == 1
    assert get_human_bearer_token() is None
    state = entrypoint._session_states[_session(7)]
    assert state.active_invocations == 0
    assert state.invocation_lock.acquire(blocking=False)
    state.invocation_lock.release()


def test_cancellation_releases_lock_state_and_allows_same_session_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", lambda **kwargs: None
    )

    async def scenario() -> None:
        started = asyncio.Event()
        wait_forever = asyncio.Event()
        closed = asyncio.Event()

        class CancellableAgent:
            async def stream_async(self, prompt: str):
                if prompt == "cancel me":
                    started.set()
                    try:
                        await wait_forever.wait()
                    finally:
                        closed.set()
                yield {"data": prompt, "delta": {"text": prompt}}

        monkeypatch.setattr(
            entrypoint, "build_supervisor_agent", lambda: CancellableAgent()
        )
        context = _context(_session(7), "same-human")
        cancelled = asyncio.create_task(_collect({"prompt": "cancel me"}, context))
        await asyncio.wait_for(started.wait(), timeout=1)
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        await asyncio.wait_for(closed.wait(), timeout=1)

        state = entrypoint._session_states[_session(7)]
        assert state.active_invocations == 0
        assert state.invocation_lock.acquire(blocking=False)
        state.invocation_lock.release()
        assert get_human_bearer_token() is None

        events = await _collect({"prompt": "after cancellation"}, context)
        assert events == [
            {"type": "text_delta", "text": "after cancellation"},
            {"type": "done"},
        ]

    asyncio.run(scenario())


def test_cancellation_while_waiting_for_session_lock_does_not_leak_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", lambda **kwargs: None
    )

    async def scenario() -> None:
        first_started = asyncio.Event()
        release_first = asyncio.Event()

        class WaitingAgent:
            async def stream_async(self, prompt: str):
                if prompt == "first":
                    first_started.set()
                    await release_first.wait()
                yield {"data": prompt, "delta": {"text": prompt}}

        monkeypatch.setattr(entrypoint, "build_supervisor_agent", lambda: WaitingAgent())
        context = _context(_session(7), "same-human")
        first = asyncio.create_task(_collect({"prompt": "first"}, context))
        await asyncio.wait_for(first_started.wait(), timeout=1)
        waiter = asyncio.create_task(_collect({"prompt": "waiting"}, context))
        await asyncio.sleep(0.05)
        state = entrypoint._session_states[_session(7)]
        assert state.active_invocations == 2

        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert state.active_invocations == 1

        release_first.set()
        await first
        assert state.active_invocations == 0
        assert state.invocation_lock.acquire(blocking=False)
        state.invocation_lock.release()

    asyncio.run(scenario())
