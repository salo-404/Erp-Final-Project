from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import agentcore_entrypoint as entrypoint
from backend_client import Unauthorized


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


def test_agentcore_rejects_missing_or_unmapped_human_before_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    supervisor_calls = {"count": 0}
    monkeypatch.setattr(
        entrypoint,
        "_supervisor_agent",
        lambda prompt: supervisor_calls.__setitem__("count", supervisor_calls["count"] + 1),
    )

    with pytest.raises(Unauthorized):
        entrypoint.invoke(
            {"prompt": "Show inventory availability"},
            SimpleNamespace(request_headers={}),
        )

    assert supervisor_calls["count"] == 0


def test_agentcore_propagates_auth_me_unauthorized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RejectingHumanClient:
        def __init__(self, token: str) -> None:
            pass

        async def get(self, path: str) -> dict:
            raise Unauthorized(401, "Cognito identity is not mapped")

    monkeypatch.setattr(entrypoint, "HumanAuthenticatedBackendClient", RejectingHumanClient)
    with pytest.raises(Unauthorized, match="not mapped"):
        asyncio.run(entrypoint._validate_human_erp_membership("unmapped-token"))
