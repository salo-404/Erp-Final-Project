"""Shared, authenticated HTTP client for the AI layer's calls to the real ERP backend.

PLUMBING ONLY - no tool file imports or uses this yet. Wiring individual
tools to real calls happens in separate follow-up passes; this module just
makes that possible.

Usage (once a tool is actually wired):

    from backend_client import get_backend_client

    client = get_backend_client()
    data = await client.get("/stock-insights/dead-stock")

get_backend_client() returns a shared, module-level singleton so every tool
reuses the same cached login token instead of each one logging in
separately - see BackendClient's own docstring below for why a fresh
BackendClient() is still sometimes appropriate (tests, isolated scripts).

Security note: service and caller-provided access tokens and the service
account password are never logged, printed, or included in an exception.
Every raised error carries only an HTTP status code and the backend's own
error message text.
"""

from __future__ import annotations

import asyncio
import base64
import json as json_module
import time
from typing import Any, Optional

import httpx

from config.settings import settings


class BackendError(Exception):
    """Base class for every typed backend error this client raises.

    Carries status_code (0 for a connection-level failure with no real HTTP
    response - timeouts, DNS failures, connection refused) and message (the
    backend's own error text, never a raw response body dump and never an
    auth token).
    """

    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        self.message = message
        super().__init__(f"Backend error {status_code}: {message}")


class Unauthorized(BackendError):
    """401 that survived BackendClient's one automatic re-login-and-retry.

    A routine expired-token 401 is handled transparently by BackendClient
    and never reaches calling code as this exception - seeing this means
    the service account's credentials are genuinely invalid (or the
    backend rejected the freshly re-logged-in token too), not just that
    the old token expired.
    """


class Forbidden(BackendError):
    """403 - authenticated successfully, but the service account's role doesn't permit this call."""


class NotFound(BackendError):
    """404."""


class ValidationError(BackendError):
    """400 or 422 - the request body/params failed backend validation."""


class Conflict(BackendError):
    """409."""


class ServiceUnavailable(BackendError):
    """5xx, a connection-level failure, or a request timeout.

    status_code is 0 for the connection-level/timeout cases (no real HTTP
    response was ever received to carry a status code).
    """


_STATUS_TO_ERROR: dict[int, type[BackendError]] = {
    400: ValidationError,
    401: Unauthorized,
    403: Forbidden,
    404: NotFound,
    409: Conflict,
    422: ValidationError,
}


def _error_for_status(status_code: int, message: str) -> BackendError:
    if status_code >= 500:
        return ServiceUnavailable(status_code, message)
    error_cls = _STATUS_TO_ERROR.get(status_code, ServiceUnavailable)
    return error_cls(status_code, message)


def _extract_error_message(response: httpx.Response) -> str:
    """Pull a human-readable message out of a Nest error response.

    Nest's default error body shape is {"message": ..., "error": ...,
    "statusCode": ...} - `message` is a plain string for most errors, or a
    list of strings for class-validator ValidationPipe failures (one per
    failed field). Falls back to the raw response text if the body isn't
    JSON-shaped as expected, so a malformed/non-JSON error response still
    produces a readable message instead of a crash while building the
    exception.
    """
    try:
        body = response.json()
    except ValueError:
        return response.text or f"HTTP {response.status_code}"
    if not isinstance(body, dict):
        return response.text or f"HTTP {response.status_code}"
    message = body.get("message", response.text)
    if isinstance(message, list):
        return "; ".join(str(item) for item in message)
    return str(message)


def _decode_jwt_expiry(token: str) -> Optional[float]:
    """Read the `exp` claim (unix seconds) straight out of the JWT payload.

    No signature verification happens here - this is purely for the
    client's OWN cache bookkeeping (avoid proactively sending a token we
    can already tell is stale, saving a round trip that would just bounce
    as a 401). The backend independently validates the token's signature
    and expiry on every real request regardless of what this function
    returns, so a wrong/missing answer here is never a trust or security
    issue - at worst it means one extra 401-triggered re-login.

    Returns None if the token isn't a three-segment JWT or carries no
    `exp` claim - the client then just treats the token's expiry as
    unknown (still works correctly; it simply can't refresh preemptively
    and instead relies on the reactive 401 re-login).
    """
    try:
        _, payload_segment, _ = token.split(".")
        padding = "=" * (-len(payload_segment) % 4)
        payload = json_module.loads(base64.urlsafe_b64decode(payload_segment + padding))
        exp = payload.get("exp")
        return float(exp) if exp is not None else None
    except (ValueError, TypeError, KeyError):
        return None


class BackendClient:
    """Authenticated HTTP client for the ERP backend.

    Logs in lazily (on first request, not at construction), caches the
    access token and its decoded expiry, sends it as a Bearer token on
    every request, and re-logs-in + retries exactly once on a 401 -
    never more than once, so a genuinely bad credential fails fast as
    Unauthorized instead of looping.

    Not meant to be instantiated per call site - use get_backend_client()
    below for a shared instance so every caller reuses the same cached
    login rather than each one logging in independently. Constructing a
    BackendClient() directly is still the right move for tests (inject a
    custom `transport`, e.g. httpx.MockTransport) or a one-off script.

    The underlying httpx.AsyncClient is built LAZILY, per running event
    loop, not once at construction - see _get_client() for why: Strands'
    synchronous Agent.__call__ runs each top-level invocation in a brand
    new thread with a brand new asyncio.run() event loop (confirmed via a
    live integration test against this project's real backend, which
    reproduced "RuntimeError: Event loop is closed" from a naive
    single-httpx.AsyncClient design). A shared BackendClient singleton
    living across many separate agent() calls would otherwise break after
    the very first one.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        email: Optional[str] = None,
        password: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._base_url = base_url if base_url is not None else settings.backend_url
        self._email = email if email is not None else settings.backend_service_email
        self._password = password if password is not None else settings.backend_service_password
        self._timeout = (
            timeout_seconds if timeout_seconds is not None else settings.backend_request_timeout_seconds
        )
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None
        self._client_loop: Optional[asyncio.AbstractEventLoop] = None
        self._token: Optional[str] = None
        self._token_expires_at: Optional[float] = None

    def _get_client(self) -> httpx.AsyncClient:
        """Return an httpx.AsyncClient bound to the CURRENTLY RUNNING event loop.

        Transparently rebuilds the client (and forgets the cached login
        token) whenever the running loop differs from the one the
        existing client was built for - including on first use. httpx's
        AsyncClient (and the anyio transport under it) binds real
        OS-level resources to the loop that was running when it was
        constructed; reusing it from a different, later event loop
        raises "RuntimeError: Event loop is closed" the moment a request
        is attempted. Multiple tool calls within the SAME agent() turn
        still share one loop and one client (and its connection pool,
        and its cached token) exactly as before - this only forces a
        rebuild across separate, independent invocations.
        """
        current_loop = asyncio.get_running_loop()
        if self._client is None or self._client_loop is not current_loop:
            self._client = httpx.AsyncClient(
                base_url=self._base_url, timeout=self._timeout, transport=self._transport
            )
            self._client_loop = current_loop
            # The old token belongs to a client bound to a dead loop -
            # there's no safe way to carry it forward, and one extra
            # login is a trivial cost next to correctness.
            self._token = None
            self._token_expires_at = None
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        """GET path, returning the parsed JSON body (or None for an empty/204 response)."""
        return await self._request("GET", path, params=params)

    async def post(self, path: str, json: Optional[dict[str, Any]] = None) -> Any:
        """POST path with a JSON body, returning the parsed JSON response (or None for empty/204)."""
        return await self._request("POST", path, json=json)

    async def _login(self) -> None:
        try:
            response = await self._get_client().post(
                "/auth/login",
                json={"email": self._email, "password": self._password},
            )
        except httpx.TimeoutException as exc:
            raise ServiceUnavailable(0, "Timed out logging in to the backend.") from exc
        except httpx.HTTPError as exc:
            raise ServiceUnavailable(
                0, f"Could not reach the backend to log in: {exc.__class__.__name__}"
            ) from exc

        if response.status_code != 200:
            raise _error_for_status(response.status_code, _extract_error_message(response))

        try:
            body = response.json()
        except ValueError as exc:
            raise ServiceUnavailable(response.status_code, "Login response was not valid JSON.") from exc

        token = body.get("access_token") if isinstance(body, dict) else None
        if not token:
            raise ServiceUnavailable(response.status_code, "Login response had no access_token.")

        self._token = token
        self._token_expires_at = _decode_jwt_expiry(token)

    async def _ensure_logged_in(self) -> None:
        # _get_client() must run FIRST: if the running loop has changed
        # since the last call, it resets self._token to None as part of
        # rebuilding the client - checking self._token before this would
        # see the stale value from the dead loop's session and skip
        # logging in, only to fail with a stale/invalid token on the
        # actual request (self-healing via the 401 retry path, but
        # wastefully - this ordering avoids that extra round trip).
        self._get_client()
        if self._token is None:
            await self._login()
            return
        if self._token_expires_at is not None and time.time() >= self._token_expires_at:
            await self._login()

    async def _send(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, Any]],
        json: Optional[dict[str, Any]],
    ) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            return await self._get_client().request(method, path, params=params, json=json, headers=headers)
        except httpx.TimeoutException as exc:
            raise ServiceUnavailable(0, f"Request to {path} timed out.") from exc
        except httpx.HTTPError as exc:
            raise ServiceUnavailable(0, f"Could not reach the backend: {exc.__class__.__name__}") from exc

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        json: Optional[dict[str, Any]] = None,
    ) -> Any:
        await self._ensure_logged_in()
        response = await self._send(method, path, params=params, json=json)

        if response.status_code == 401:
            # Exactly one re-login + retry. A 401 that survives a FRESH
            # login means the credentials themselves are bad (or the
            # account was disabled, or the role changed) - not that the
            # old token merely expired - so this does not loop.
            await self._login()
            response = await self._send(method, path, params=params, json=json)

        if response.status_code >= 400:
            raise _error_for_status(response.status_code, _extract_error_message(response))

        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise ServiceUnavailable(response.status_code, "Response was not valid JSON.") from exc


class HumanAuthenticatedBackendClient:
    """Non-caching client for one propagated human bearer token.

    This client never logs in, never knows service-account credentials, and
    never retries a 401 as another identity. Construct it inside the current
    request scope only for endpoints that intentionally act as the human user.
    """

    def __init__(
        self,
        bearer_token: str,
        base_url: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        if not bearer_token:
            raise ValueError("bearer_token must not be empty")
        self._bearer_token = bearer_token
        self._base_url = base_url if base_url is not None else settings.backend_url
        self._timeout = timeout_seconds or settings.backend_request_timeout_seconds
        self._transport = transport

    async def post(self, path: str, json: Optional[dict[str, Any]] = None) -> Any:
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    path,
                    json=json,
                    headers={"Authorization": f"Bearer {self._bearer_token}"},
                )
        except httpx.TimeoutException as exc:
            raise ServiceUnavailable(0, f"Request to {path} timed out.") from exc
        except httpx.HTTPError as exc:
            raise ServiceUnavailable(
                0,
                f"Could not reach the backend: {exc.__class__.__name__}",
            ) from exc

        if response.status_code >= 400:
            raise _error_for_status(response.status_code, _extract_error_message(response))
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise ServiceUnavailable(response.status_code, "Response was not valid JSON.") from exc


_shared_client: Optional[BackendClient] = None


def get_backend_client() -> BackendClient:
    """Shared BackendClient instance.

    Every tool should call this rather than constructing its own
    BackendClient, so the cached login token is reused across tool calls
    instead of each tool logging in independently.
    """
    global _shared_client
    if _shared_client is None:
        _shared_client = BackendClient()
    return _shared_client
