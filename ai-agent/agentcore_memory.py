"""Supervisor-only short-term Amazon Bedrock AgentCore Memory integration."""

from __future__ import annotations

from bedrock_agentcore.memory.integrations.strands.config import (
    AgentCoreMemoryConfig,
)
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)

from config.settings import settings


class AgentCoreMemoryConfigurationError(RuntimeError):
    """Raised when required or configured short-term Memory cannot be used."""


def build_agentcore_memory_session_manager(
    *, actor_id: str, session_id: str
) -> AgentCoreMemorySessionManager | None:
    """Build one short-term Memory manager for an authenticated conversation."""
    memory_id = settings.agentcore_memory_id.strip()
    if not memory_id:
        if settings.agentcore_memory_required:
            raise AgentCoreMemoryConfigurationError(
                "AGENTCORE_MEMORY_ID is required when AGENTCORE_MEMORY_REQUIRED=true"
            )
        return None

    try:
        memory_config = AgentCoreMemoryConfig(
            memory_id=memory_id,
            actor_id=actor_id,
            session_id=session_id,
            batch_size=1,
            async_mode=True,
        )
        return AgentCoreMemorySessionManager(
            agentcore_memory_config=memory_config,
            region_name=settings.aws_region,
        )
    except Exception as exc:
        raise AgentCoreMemoryConfigurationError(
            "Configured AgentCore Memory could not be initialized"
        ) from exc
