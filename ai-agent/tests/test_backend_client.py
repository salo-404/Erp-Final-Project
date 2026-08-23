"""Tests for backend_client.py - the AI layer's shared, authenticated HTTP
client for the real ERP backend.

All backend HTTP calls here are mocked via httpx.MockTransport - none of
these tests need a real backend running. (The live-backend check for
re-login-on-401 behavior against a real running server is a separate
manual/e2e verification, not part of this offline suite.)

No pytest-asyncio dependency: BackendClient's methods are async, but every
test below is a plain sync `def test_...` driving the async code via
asyncio.run() - matching this project's existing minimal-dependency
approach (see requirements.txt; pytest-asyncio isn't installed).
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from types import SimpleNamespace
from typing import Any, Callable, Coroutine, TypeVar

import httpx
import pytest

import backend_client as backend_client_module
from backend_client import (
    BackendClient,
    Conflict,
    Forbidden,
    HumanAuthenticatedBackendClient,
    NotFound,
    ServiceUnavailable,
    Unauthorized,
    ValidationError,
    get_backend_client,
)

T = TypeVar("T")


def _run(coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def _fake_jwt(exp_seconds_from_now: float = 3600) -> str:
    """A minimal, correctly-SHAPED (but unsigned) JWT for tests.

    backend_client only ever reads the payload's `exp` claim for its own
    cache bookkeeping - it never verifies the signature (see
    _decode_jwt_expiry's docstring for why that's fine) - so a fake
    signature segment is enough to exercise that code path.
    """
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "sub": 1,
                "email": "ai-agent@internal.local",
                "role": "EMPLOYEE",
                "exp": time.time() + exp_seconds_from_now,
            }
        ).encode()
    ).decode().rstrip("=")
    return f"{header}.{payload}.fake-signature"


def _client(handler: Callable[[httpx.Request], httpx.Response], **overrides: Any) -> BackendClient:
    async def default_token_provider() -> str:
        return _fake_jwt()

    defaults: dict[str, Any] = {
        "base_url": "http://backend.test",
        "timeout_seconds": 1,
        "service_token_provider": default_token_provider,
    }
    defaults.update(overrides)
    return BackendClient(transport=httpx.MockTransport(handler), **defaults)


def test_successful_login_then_authenticated_request_sends_bearer_token() -> None:
    token = _fake_jwt()
    login_calls = {"n": 0}

    async def token_provider() -> str:
        login_calls["n"] += 1
        return token

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path != "/auth/login"
        assert request.headers["Authorization"] == f"Bearer {token}"
        return httpx.Response(200, json={"ok": True})

    client = _client(handler, service_token_provider=token_provider)
    result = _run(client.get("/warehouses"))
    assert result == {"ok": True}
    assert login_calls["n"] == 1


def test_default_service_auth_obtains_cognito_access_token_with_admin_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = _fake_jwt()
    cognito_calls: list[dict] = []

    class FakeCognitoClient:
        def admin_initiate_auth(self, **kwargs):
            cognito_calls.append(kwargs)
            return {"AuthenticationResult": {"AccessToken": token}}

    monkeypatch.setattr(
        backend_client_module.boto3,
        "client",
        lambda service, region_name: FakeCognitoClient(),
    )
    monkeypatch.setattr(
        backend_client_module,
        "settings",
        SimpleNamespace(
            aws_region="eu-west-1",
            backend_url="http://backend.test",
            backend_request_timeout_seconds=1,
            cognito_user_pool_id="pool-1",
            cognito_app_client_id="frontend-client",
            cognito_service_app_client_id="service-client-1",
            backend_service_cognito_username="ai-service",
            backend_service_cognito_password="cognito-secret",
        ),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path != "/auth/login"
        assert request.headers["Authorization"] == f"Bearer {token}"
        return httpx.Response(200, json={"ok": True})

    client = BackendClient(
        base_url="http://backend.test",
        transport=httpx.MockTransport(handler),
    )
    assert _run(client.get("/products")) == {"ok": True}
    assert cognito_calls == [
        {
            "UserPoolId": "pool-1",
            "ClientId": "service-client-1",
            "AuthFlow": "ADMIN_USER_PASSWORD_AUTH",
            "AuthParameters": {"USERNAME": "ai-service", "PASSWORD": "cognito-secret"},
        }
    ]


def test_get_sends_query_params_and_returns_parsed_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["productId"] == "42"
        return httpx.Response(200, json={"items": [1, 2, 3]})

    client = _client(handler)
    result = _run(client.get("/stock-insights/dead-stock", params={"productId": 42}))
    assert result == {"items": [1, 2, 3]}


def test_post_sends_json_body() -> None:
    received_body: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        received_body.update(json.loads(request.content))
        return httpx.Response(201, json={"id": 1})

    client = _client(handler)
    result = _run(client.post("/suppliers", json={"name": "Test Supplier"}))
    assert result == {"id": 1}
    assert received_body == {"name": "Test Supplier"}


def test_401_triggers_exactly_one_relogin_and_retry() -> None:
    """A transient 401 (e.g. the cached token expired) must self-heal:
    exactly one fresh login, exactly one retry of the original request -
    and the retry must succeed."""
    login_calls = {"n": 0}
    request_calls = {"n": 0}

    async def token_provider() -> str:
        login_calls["n"] += 1
        return _fake_jwt()

    def handler(request: httpx.Request) -> httpx.Response:
        request_calls["n"] += 1
        if request_calls["n"] == 1:
            return httpx.Response(401, json={"message": "jwt expired"})
        return httpx.Response(200, json={"ok": True})

    client = _client(handler, service_token_provider=token_provider)
    result = _run(client.get("/widgets"))

    assert result == {"ok": True}
    assert login_calls["n"] == 2, "initial login + exactly one re-login after the 401"
    assert request_calls["n"] == 2, "original request + exactly one retry"


def test_persistent_401_raises_unauthorized_without_looping() -> None:
    """A 401 that survives a FRESH login (genuinely bad credentials, a
    disabled account, etc.) must raise Unauthorized after exactly one
    retry - never loop indefinitely."""
    login_calls = {"n": 0}
    request_calls = {"n": 0}

    async def token_provider() -> str:
        login_calls["n"] += 1
        return _fake_jwt()

    def handler(request: httpx.Request) -> httpx.Response:
        request_calls["n"] += 1
        return httpx.Response(401, json={"message": "invalid credentials"})

    client = _client(handler, service_token_provider=token_provider)
    with pytest.raises(Unauthorized) as exc_info:
        _run(client.get("/widgets"))

    assert exc_info.value.status_code == 401
    assert login_calls["n"] == 2, "must not attempt a third login"
    assert request_calls["n"] == 2, "must not attempt a third request"


@pytest.mark.parametrize(
    "status_code,expected_exception",
    [
        (400, ValidationError),
        (403, Forbidden),
        (404, NotFound),
        (409, Conflict),
        (422, ValidationError),
        (500, ServiceUnavailable),
        (503, ServiceUnavailable),
    ],
)
def test_error_status_codes_map_to_typed_exceptions(
    status_code: int, expected_exception: type[Exception]
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"message": f"simulated {status_code}"})

    client = _client(handler)
    with pytest.raises(expected_exception) as exc_info:
        _run(client.get("/widgets"))

    assert exc_info.value.status_code == status_code  # type: ignore[attr-defined]
    assert f"simulated {status_code}" in exc_info.value.message  # type: ignore[attr-defined]


def test_validation_error_joins_a_list_of_field_messages() -> None:
    """class-validator's ValidationPipe returns `message` as a list of
    per-field strings, not a single string - confirm those get joined into
    one readable message rather than crashing or being dropped."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"message": ["name should not be empty", "email must be an email"]}
        )

    client = _client(handler)
    with pytest.raises(ValidationError) as exc_info:
        _run(client.post("/suppliers", json={}))

    assert "name should not be empty" in exc_info.value.message
    assert "email must be an email" in exc_info.value.message


def test_request_timeout_raises_service_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("simulated timeout", request=request)

    client = _client(handler)
    with pytest.raises(ServiceUnavailable):
        _run(client.get("/widgets"))


def test_cognito_auth_failure_raises_service_unavailable() -> None:
    async def failing_provider() -> str:
        raise ServiceUnavailable(0, "Cognito unavailable")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("backend request must not run without a service token")

    client = _client(handler, service_token_provider=failing_provider)
    with pytest.raises(ServiceUnavailable):
        _run(client.get("/widgets"))


def test_no_token_value_ever_appears_in_a_raised_exception() -> None:
    token = _fake_jwt()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "forbidden for this role"})

    client = _client(handler)
    with pytest.raises(Forbidden) as exc_info:
        _run(client.get("/widgets"))

    assert token not in str(exc_info.value)
    assert token not in repr(exc_info.value)


def test_no_service_secret_value_ever_appears_in_an_auth_exception() -> None:
    password = "super-secret-cognito-password"  # noqa: S105 - test fixture, not a real credential

    async def failing_provider() -> str:
        raise ServiceUnavailable(0, "Could not authenticate the AI service identity with Cognito.")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("backend request must not run without a service token")

    client = _client(handler, service_token_provider=failing_provider)
    with pytest.raises(ServiceUnavailable) as exc_info:
        _run(client.get("/widgets"))

    assert password not in str(exc_info.value)
    assert password not in repr(exc_info.value)


def test_get_backend_client_returns_a_shared_singleton() -> None:
    first = get_backend_client()
    second = get_backend_client()
    assert first is second


def test_human_client_uses_only_supplied_bearer_and_never_logs_in() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.headers["Authorization"] == "Bearer human-jwt"
        return httpx.Response(200, json={"ok": True})

    client = HumanAuthenticatedBackendClient(
        "human-jwt",
        base_url="http://backend.test",
        transport=httpx.MockTransport(handler),
    )
    assert _run(client.get("/auth/me")) == {"ok": True}
    assert _run(client.post("/document-review/501/approve", json={"items": []})) == {
        "ok": True
    }
    assert paths == ["/auth/me", "/document-review/501/approve"]


def test_human_client_does_not_retry_unauthorized_as_another_identity() -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(401, json={"message": "expired"})

    client = HumanAuthenticatedBackendClient(
        "expired-human-jwt",
        base_url="http://backend.test",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(Unauthorized):
        _run(client.post("/document-review/501/reject", json={"rejectionReason": "x"}))
    assert calls["count"] == 1


def test_same_client_instance_works_across_separate_event_loops() -> None:
    """Regression test: Strands' Agent.__call__ runs each top-level
    invocation in a brand-new thread with a brand-new asyncio.run() event
    loop (strands/_async.py::run_async) - so a module-level BackendClient
    singleton, reused across separate agent() calls, gets handed a
    DIFFERENT running loop on its second call than the one its
    httpx.AsyncClient was originally built for. Before _get_client()'s
    per-loop rebuild existed, this reproduced a real
    "RuntimeError: Event loop is closed" - caught via a live integration
    test against the real backend, not found in mocked tests alone, since
    every mocked test up to that point only ever called asyncio.run()
    once per BackendClient instance.
    """
    login_calls = {"n": 0}

    async def token_provider() -> str:
        login_calls["n"] += 1
        return _fake_jwt()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    client = _client(handler, service_token_provider=token_provider)

    first_result = _run(client.get("/warehouses"))  # first asyncio.run() - builds the client for loop A
    second_result = _run(client.get("/warehouses"))  # second, SEPARATE asyncio.run() - loop B

    assert first_result == {"ok": True}
    assert second_result == {"ok": True}
    assert login_calls["n"] == 2, "a fresh loop must trigger a fresh login, not reuse a dead client"
