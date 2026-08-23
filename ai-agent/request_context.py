"""Request-scoped human authentication context for intentional user actions."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar


_human_bearer_token: ContextVar[str | None] = ContextVar(
    "human_bearer_token",
    default=None,
)


def get_human_bearer_token() -> str | None:
    """Return the current request's human JWT, never a service-account token."""
    return _human_bearer_token.get()


@contextmanager
def human_auth_scope(bearer_token: str | None) -> Iterator[None]:
    """Set human auth for one request and reliably reset it afterward."""
    token = _human_bearer_token.set(bearer_token)
    try:
        yield
    finally:
        _human_bearer_token.reset(token)
