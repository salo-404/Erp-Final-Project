"""Unit tests for the shared NestJS backend JSON client."""

from __future__ import annotations

import io
import json
import socket
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import pytest

from clients.backend_http import (
    BackendConfigurationError,
    BackendConnectionError,
    BackendHttpClient,
    BackendInvalidResponseError,
    BackendResponseError,
    BackendTimeoutError,
)


class FakeResponse:
    def __init__(self, body: object) -> None:
        self.body = json.dumps(body).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def test_get_sends_query_bearer_token_and_timeout() -> None:
    client = BackendHttpClient(
        base_url="https://backend.example.test/",
        auth_token="test-token",
        timeout_seconds=7,
    )

    with patch(
        "clients.backend_http.urlopen",
        return_value=FakeResponse({"items": [1]}),
    ) as mocked_urlopen:
        result = client.get(
            "/stock-insights/stockout-risk",
            query={"windowDays": 30, "ignored": None},
        )

    request = mocked_urlopen.call_args.args[0]
    assert result == {"items": [1]}
    assert request.full_url == (
        "https://backend.example.test/stock-insights/stockout-risk?windowDays=30"
    )
    assert request.get_method() == "GET"
    assert request.get_header("Authorization") == "Bearer test-token"
    assert mocked_urlopen.call_args.kwargs["timeout"] == 7


def test_post_sends_and_decodes_json_without_auth_when_token_is_empty() -> None:
    client = BackendHttpClient(
        base_url="https://backend.example.test",
        auth_token="",
        timeout_seconds=5,
    )

    with patch(
        "clients.backend_http.urlopen",
        return_value=FakeResponse({"ok": True}),
    ) as mocked_urlopen:
        result = client.post("/resource", json_body={"value": 3})

    request = mocked_urlopen.call_args.args[0]
    assert result == {"ok": True}
    assert request.get_method() == "POST"
    assert json.loads(request.data.decode("utf-8")) == {"value": 3}
    assert request.get_header("Content-type") == "application/json"
    assert request.get_header("Authorization") is None


def test_non_2xx_response_raises_clear_error() -> None:
    client = BackendHttpClient("https://backend.example.test", timeout_seconds=5)
    error = HTTPError(
        url="https://backend.example.test/resource",
        code=401,
        msg="Unauthorized",
        hdrs={},
        fp=io.BytesIO(b'{"message":"Unauthorized"}'),
    )

    with patch("clients.backend_http.urlopen", side_effect=error):
        with pytest.raises(BackendResponseError) as raised:
            client.get("/resource")

    assert raised.value.status_code == 401
    assert "Unauthorized" in str(raised.value)


@pytest.mark.parametrize(
    ("failure", "expected_exception"),
    [
        (URLError("connection refused"), BackendConnectionError),
        (socket.timeout("timed out"), BackendTimeoutError),
        (URLError(socket.timeout("timed out")), BackendTimeoutError),
    ],
)
def test_transport_failures_are_translated(failure, expected_exception) -> None:
    client = BackendHttpClient("https://backend.example.test", timeout_seconds=5)

    with patch("clients.backend_http.urlopen", side_effect=failure):
        with pytest.raises(expected_exception):
            client.get("/resource")


def test_invalid_json_response_raises_clear_error() -> None:
    client = BackendHttpClient("https://backend.example.test", timeout_seconds=5)
    response = FakeResponse({"unused": True})
    response.body = b"not-json"

    with patch("clients.backend_http.urlopen", return_value=response):
        with pytest.raises(BackendInvalidResponseError):
            client.get("/resource")


def test_missing_base_url_and_invalid_timeout_are_rejected() -> None:
    with pytest.raises(BackendConfigurationError):
        BackendHttpClient(base_url="", timeout_seconds=5)

    with pytest.raises(BackendConfigurationError):
        BackendHttpClient(
            base_url="https://backend.example.test",
            timeout_seconds=0,
        )
