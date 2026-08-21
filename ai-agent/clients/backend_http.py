"""Small JSON HTTP client for the NestJS backend.

This module is deliberately transport-only. ERP-specific request and response
adaptation belongs in the individual agent tools that will use this client.
"""

from __future__ import annotations

import json
import socket
from collections.abc import Mapping
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from config.settings import settings


class BackendClientError(RuntimeError):
    """Base class for backend HTTP client failures."""


class BackendConfigurationError(BackendClientError):
    """Raised when required backend client configuration is invalid."""


class BackendConnectionError(BackendClientError):
    """Raised when a connection to the backend cannot be established."""


class BackendTimeoutError(BackendClientError):
    """Raised when the backend does not respond within the configured timeout."""


class BackendResponseError(BackendClientError):
    """Raised when the backend returns a non-success HTTP response."""

    def __init__(self, status_code: int, response_body: str) -> None:
        self.status_code = status_code
        self.response_body = response_body
        detail = f": {response_body}" if response_body else ""
        super().__init__(f"Backend returned HTTP {status_code}{detail}")


class BackendInvalidResponseError(BackendClientError):
    """Raised when a successful backend response is not valid JSON."""


class BackendHttpClient:
    """Synchronous JSON client for the NestJS backend API."""

    def __init__(
        self,
        base_url: str | None = None,
        auth_token: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self.base_url = (
            settings.backend_base_url if base_url is None else base_url
        ).strip().rstrip("/")
        self.auth_token = (
            settings.backend_auth_token if auth_token is None else auth_token
        ).strip()
        self.timeout_seconds = (
            settings.backend_request_timeout_seconds
            if timeout_seconds is None
            else timeout_seconds
        )

        if not self.base_url:
            raise BackendConfigurationError("BACKEND_BASE_URL is not configured")
        if self.timeout_seconds <= 0:
            raise BackendConfigurationError(
                "BACKEND_REQUEST_TIMEOUT_SECONDS must be greater than zero"
            )

    def get(
        self,
        path: str,
        query: Mapping[str, Any] | None = None,
    ) -> Any:
        """Send a GET request and return its decoded JSON response."""
        return self._request("GET", path, query=query)

    def post(
        self,
        path: str,
        json_body: Any | None = None,
        query: Mapping[str, Any] | None = None,
    ) -> Any:
        """Send a POST request with an optional JSON body and return JSON."""
        return self._request("POST", path, query=query, json_body=json_body)

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        json_body: Any | None = None,
    ) -> Any:
        url = self._build_url(path, query)
        headers = {"Accept": "application/json"}

        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        body: bytes | None = None
        if json_body is not None:
            try:
                body = json.dumps(json_body).encode("utf-8")
            except (TypeError, ValueError) as exc:
                raise BackendClientError(
                    "Backend request body is not JSON serializable"
                ) from exc
            headers["Content-Type"] = "application/json"

        request = Request(url, data=body, headers=headers, method=method)

        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                raw_body = response.read()
        except HTTPError as exc:
            response_body = self._decode_error_body(exc.read())
            raise BackendResponseError(exc.code, response_body) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise BackendTimeoutError(
                f"Backend request timed out after {self.timeout_seconds} seconds"
            ) from exc
        except URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                raise BackendTimeoutError(
                    f"Backend request timed out after {self.timeout_seconds} seconds"
                ) from exc
            raise BackendConnectionError(
                f"Could not connect to backend: {exc.reason}"
            ) from exc
        except OSError as exc:
            raise BackendConnectionError(
                f"Could not connect to backend: {exc}"
            ) from exc

        try:
            return json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BackendInvalidResponseError(
                "Backend returned a successful response that was not valid JSON"
            ) from exc

    def _build_url(
        self,
        path: str,
        query: Mapping[str, Any] | None,
    ) -> str:
        if not path or not path.strip():
            raise BackendConfigurationError("Backend request path cannot be empty")

        url = f"{self.base_url}/{path.lstrip('/')}"
        if query:
            filtered_query = {
                key: value for key, value in query.items() if value is not None
            }
            if filtered_query:
                url = f"{url}?{urlencode(filtered_query, doseq=True)}"
        return url

    @staticmethod
    def _decode_error_body(raw_body: bytes) -> str:
        if not raw_body:
            return ""
        try:
            decoded = raw_body.decode("utf-8")
        except UnicodeDecodeError:
            return "unreadable response body"

        # Keep errors useful without echoing an arbitrarily large response.
        return decoded[:1000]
