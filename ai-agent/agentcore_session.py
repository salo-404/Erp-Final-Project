"""Stateless ownership namespace for AgentCore runtime session IDs."""

from __future__ import annotations

import re
import uuid

_SESSION_ID_PATTERN = re.compile(
    r"^erp-user-(?P<owner>[1-9][0-9]*)-(?P<conversation>[0-9a-f]{32})$"
)
_MIN_SESSION_ID_LENGTH = 33
_MAX_SESSION_ID_LENGTH = 100


def build_runtime_session_id(erp_user_id: int | str) -> str:
    """Create a canonical, non-secret session namespace for a new conversation."""
    owner = str(erp_user_id).strip()
    if not re.fullmatch(r"[1-9][0-9]*", owner):
        raise ValueError("ERP user ID must be a positive integer")

    session_id = f"erp-user-{owner}-{uuid.uuid4().hex}"
    if len(session_id) > _MAX_SESSION_ID_LENGTH:
        raise ValueError("ERP user ID is too long for an AgentCore runtime session ID")
    return session_id


def parse_runtime_session_owner(session_id: str) -> str:
    """Return the encoded owner without treating it as authentication."""
    if not _MIN_SESSION_ID_LENGTH <= len(session_id) <= _MAX_SESSION_ID_LENGTH:
        raise ValueError(
            "AgentCore runtime session ID must use the required user-owned format."
        )
    match = _SESSION_ID_PATTERN.fullmatch(session_id)
    if match is None:
        raise ValueError(
            "AgentCore runtime session ID must use the required user-owned format."
        )
    return match.group("owner")
