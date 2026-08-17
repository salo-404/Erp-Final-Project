"""Bedrock Guardrails configuration for the Supervisor.

This is layer 1 of the Supervisor's three-layer defense - see
agents/supervisor/prompts.py for the full picture.

TODO: This is a placeholder. No real Bedrock Guardrail has been created or
attached yet. `get_guardrail_config()` currently returns an empty dict
(no-op) whenever config.settings.settings.guardrail_id is unset, so the
Supervisor runs today with NO guardrail protection - layers 2 (gate.py) and
3 (the hardened system prompt) are the only defenses currently active.

To wire up a real guardrail:
  1. Create a Bedrock Guardrail in the AWS console/CDK for this account,
     with content filters, denied topics, and PII redaction appropriate for
     an ERP assistant (e.g. deny topics unrelated to inventory/documents,
     block attempts to exfiltrate system prompts or other users' data).
  2. Set BEDROCK_GUARDRAIL_ID / BEDROCK_GUARDRAIL_VERSION in the
     environment (see .env.example).
  3. Pass the dict returned by get_guardrail_config() into the
     Supervisor's BedrockModel(**get_guardrail_config()) construction in
     agents/supervisor/agent.py.
"""

from __future__ import annotations

from config.settings import settings


def get_guardrail_config() -> dict:
    """Return BedrockModel kwargs for the configured guardrail, or {} if none is set.

    TODO: real guardrail wiring - see module docstring.
    """
    if not settings.guardrail_id:
        return {}

    return {
        "guardrail_id": settings.guardrail_id,
        "guardrail_version": settings.guardrail_version,
        "guardrail_trace": "enabled",
    }
