from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

import agentcore_entrypoint as entrypoint
import agentcore_memory as memory
from agents.document_agent.agent import build_document_agent
from agents.insights_agent.agent import build_insights_agent
from agents.supervisor import agent as supervisor_agent_module
from backend_client import Forbidden, Unauthorized


@pytest.fixture(autouse=True)
def reset_session_registry() -> None:
    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()
    yield
    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()


def _settings(*, memory_id: str = "", required: bool = False) -> object:
    return SimpleNamespace(
        agentcore_memory_id=memory_id,
        agentcore_memory_required=required,
        aws_region="eu-west-1",
    )


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


class _Agent:
    def __init__(self) -> None:
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> str:
        self.prompts.append(prompt)
        return f"answer:{prompt}"


def test_optional_local_mode_does_not_construct_memory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(memory, "settings", _settings())
    monkeypatch.setattr(
        memory,
        "AgentCoreMemorySessionManager",
        lambda **kwargs: pytest.fail("Memory must not be constructed"),
    )

    assert (
        memory.build_agentcore_memory_session_manager(
            actor_id="7", session_id=_session(7)
        )
        is None
    )


def test_required_memory_without_id_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(memory, "settings", _settings(required=True))

    with pytest.raises(
        memory.AgentCoreMemoryConfigurationError,
        match="AGENTCORE_MEMORY_ID is required",
    ):
        memory.build_agentcore_memory_session_manager(
            actor_id="7", session_id=_session(7)
        )


def test_configured_memory_uses_short_term_actor_session_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeManager:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(memory, "settings", _settings(memory_id="memory-123"))
    monkeypatch.setattr(memory, "AgentCoreMemorySessionManager", FakeManager)

    manager = memory.build_agentcore_memory_session_manager(
        actor_id="7", session_id=_session(7)
    )

    assert isinstance(manager, FakeManager)
    assert captured["region_name"] == "eu-west-1"
    config = captured["agentcore_memory_config"]
    assert isinstance(config, memory.AgentCoreMemoryConfig)
    assert config.memory_id == "memory-123"
    assert config.actor_id == "7"
    assert config.session_id == _session(7)
    assert config.batch_size == 1
    assert config.async_mode is False
    assert config.retrieval_config is None
    assert config.default_metadata is None
    assert config.metadata_provider is None
    assert not any(
        sensitive in config.model_dump()
        for sensitive in ("token", "bearer", "jwt", "email", "credential")
    )


def test_configured_memory_construction_failure_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(memory, "settings", _settings(memory_id="memory-123"))

    def fail(**kwargs: object) -> None:
        raise RuntimeError("simulated AWS SDK failure")

    monkeypatch.setattr(memory, "AgentCoreMemorySessionManager", fail)

    with pytest.raises(
        memory.AgentCoreMemoryConfigurationError,
        match="could not be initialized",
    ):
        memory.build_agentcore_memory_session_manager(
            actor_id="7", session_id=_session(7)
        )


def test_configured_memory_restoration_failure_does_not_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    manager = object()
    monkeypatch.setattr(
        entrypoint,
        "build_agentcore_memory_session_manager",
        lambda **kwargs: manager,
    )

    def fail_restoration(*, session_manager: object) -> None:
        assert session_manager is manager
        raise RuntimeError("simulated Memory restoration failure")

    monkeypatch.setattr(entrypoint, "build_supervisor_agent", fail_restoration)

    with pytest.raises(RuntimeError, match="Memory restoration failure"):
        entrypoint.invoke(
            {"prompt": "Resume"}, _context(_session(7), "same-human")
        )

    assert entrypoint._session_states[_session(7)].supervisor_agent is None


def test_authoritative_context_and_auth_identity_feed_memory_not_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"real-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    memory_calls: list[dict[str, str]] = []
    manager = object()
    built: list[object] = []

    def build_memory(**kwargs: str) -> object:
        memory_calls.append(kwargs)
        return manager

    def build_supervisor(*, session_manager: object) -> _Agent:
        built.append(session_manager)
        return _Agent()

    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", build_memory
    )
    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build_supervisor)

    entrypoint.invoke(
        {
            "prompt": "Show inventory",
            "userId": 999,
            "sessionId": _session(999),
            "conversationId": "payload-conversation",
        },
        _context(_session(7), "real-human"),
    )

    assert memory_calls == [{"actor_id": "7", "session_id": _session(7)}]
    assert built == [manager]


def test_same_live_session_builds_one_manager_and_one_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    managers: list[object] = []
    agents: list[_Agent] = []

    def build_memory(**kwargs: str) -> object:
        manager = object()
        managers.append(manager)
        return manager

    def build_supervisor(*, session_manager: object) -> _Agent:
        assert session_manager is managers[-1]
        agent = _Agent()
        agents.append(agent)
        return agent

    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", build_memory
    )
    monkeypatch.setattr(entrypoint, "build_supervisor_agent", build_supervisor)

    context = _context(_session(7), "same-human")
    entrypoint.invoke({"prompt": "First"}, context)
    entrypoint.invoke({"prompt": "Follow up"}, context)

    assert len(managers) == 1
    assert len(agents) == 1
    assert agents[0].prompts == ["First", "Follow up"]


def test_actor_and_session_isolation_create_separate_managers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"user-seven": 7, "user-eight": 8})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    identities: list[tuple[str, str]] = []

    def build_memory(*, actor_id: str, session_id: str) -> object:
        identities.append((actor_id, session_id))
        return object()

    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", build_memory
    )
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda *, session_manager: _Agent(),
    )

    entrypoint.invoke(
        {"prompt": "A"}, _context(_session(7, "a"), "user-seven")
    )
    entrypoint.invoke(
        {"prompt": "B"}, _context(_session(7, "b"), "user-seven")
    )
    entrypoint.invoke(
        {"prompt": "C"}, _context(_session(8, "c"), "user-eight")
    )

    assert identities == [
        ("7", _session(7, "a")),
        ("7", _session(7, "b")),
        ("8", _session(8, "c")),
    ]


def test_cross_user_takeover_fails_before_memory_gate_or_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"user-eight": 8})
    monkeypatch.setattr(
        entrypoint,
        "build_agentcore_memory_session_manager",
        lambda **kwargs: pytest.fail("Memory must not be constructed"),
    )
    monkeypatch.setattr(
        entrypoint,
        "is_in_scope",
        lambda prompt: pytest.fail("Gate must not run"),
    )
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda **kwargs: pytest.fail("Supervisor must not be built"),
    )

    with pytest.raises(Forbidden, match="ownership does not match"):
        entrypoint.invoke(
            {"prompt": "Show inventory"},
            _context(_session(7), "user-eight"),
        )


def test_registry_reset_rebuilds_same_memory_identity_and_restores_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_membership(monkeypatch, {"same-human": 7})
    monkeypatch.setattr(entrypoint, "is_in_scope", lambda prompt: (True, "allowed"))
    persisted: dict[tuple[str, str], list[str]] = {}
    manager_keys: list[tuple[str, str]] = []
    restored_histories: list[list[str]] = []

    class FakeMemoryManager:
        def __init__(self, actor_id: str, session_id: str) -> None:
            self.key = (actor_id, session_id)
            self.history = persisted.setdefault(self.key, [])

    class RestoringAgent:
        def __init__(self, session_manager: FakeMemoryManager) -> None:
            self.manager = session_manager
            restored_histories.append(list(session_manager.history))

        def __call__(self, prompt: str) -> str:
            prior = list(self.manager.history)
            self.manager.history.append(prompt)
            return f"prior={prior}; current={prompt}"

    def build_memory(*, actor_id: str, session_id: str) -> FakeMemoryManager:
        manager_keys.append((actor_id, session_id))
        return FakeMemoryManager(actor_id, session_id)

    monkeypatch.setattr(
        entrypoint, "build_agentcore_memory_session_manager", build_memory
    )
    monkeypatch.setattr(
        entrypoint,
        "build_supervisor_agent",
        lambda *, session_manager: RestoringAgent(session_manager),
    )

    session_id = _session(7)
    entrypoint.invoke({"prompt": "Before stop"}, _context(session_id, "same-human"))
    with entrypoint._session_registry_lock:
        entrypoint._session_states.clear()
    result = entrypoint.invoke(
        {"prompt": "After restart"}, _context(session_id, "same-human")
    )

    assert manager_keys == [("7", session_id), ("7", session_id)]
    assert restored_histories == [[], ["Before stop"]]
    assert result["result"] == "prior=['Before stop']; current=After restart"


def test_supervisor_accepts_session_manager_without_changing_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeAgent:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    fake_settings = SimpleNamespace(
        build_model=lambda agent_name: object(), model_provider="openai"
    )
    manager = object()
    monkeypatch.setattr(supervisor_agent_module, "settings", fake_settings)
    monkeypatch.setattr(supervisor_agent_module, "Agent", FakeAgent)
    monkeypatch.setattr(supervisor_agent_module, "get_guardrail_config", lambda: {})

    supervisor_agent_module.build_supervisor_agent(session_manager=manager)

    assert captured["session_manager"] is manager
    assert captured["tools"] == supervisor_agent_module.SUPERVISOR_TOOLS
    assert len(captured["tools"]) == 2
    assert "conversation_manager" not in captured
    assert "agent_id" not in captured


def test_specialists_do_not_accept_or_receive_session_manager() -> None:
    assert "session_manager" not in inspect.signature(build_insights_agent).parameters
    assert "session_manager" not in inspect.signature(build_document_agent).parameters
    assert "session_manager=" not in inspect.getsource(build_insights_agent)
    assert "session_manager=" not in inspect.getsource(build_document_agent)
