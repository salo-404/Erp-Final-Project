"""Supervisor agent - Agents-as-Tools pattern.

Imports the Insights and Document specialist agents as @tool-wrapped
functions and attaches them to a single top-level Agent. Both specialists
remain fully independent modules (see agents/insights_agent/agent.py and
agents/document_agent/agent.py) - the Supervisor merely composes them.

Before any of that, handle_query() runs the scope gate (agents/supervisor/gate.py)
- a separate, small classification call that rejects obviously out-of-scope
queries before the Supervisor agent is even constructed, so they never
reach a specialist tool at all.

Routing after the gate is intentionally model-driven: the Supervisor prompt
and the two specialist tool descriptions direct the model to Insights,
Document, or a sequential Document-to-Insights workflow. There is deliberately
no duplicate keyword router. See tests/test_supervisor_wiring.py for the
routing contract and tests/test_gate.py for the gate's tests.
"""

from __future__ import annotations

from strands import Agent

from request_context import human_auth_scope

from agents.document_agent.agent import document_agent_tool
from agents.insights_agent.agent import insights_agent_tool
from agents.supervisor.gate import is_in_scope
from agents.supervisor.guardrails import get_guardrail_config
from agents.supervisor.prompts import SUPERVISOR_SYSTEM_PROMPT
from config.settings import settings

SUPERVISOR_TOOLS = [
    insights_agent_tool,
    document_agent_tool,
]


def build_supervisor_agent() -> Agent:
    """Construct the top-level Supervisor Agent.

    Architecture is LOCKED at exactly 3 agents: this Supervisor plus the
    two specialists it wraps as tools (Insights, Document). Do not add a
    third specialist agent - new inventory/procurement capabilities belong
    inside the Insights agent's tools, and new document-processing
    capabilities belong inside the Document agent's tools.

    The model provider (OpenAI/Ollama for local dev, Bedrock for
    production) is decided entirely by settings.build_model() - see
    config/settings.py - so switching providers never touches this
    function, matching the same pattern already used by
    build_insights_agent() / build_document_agent().
    """
    model = settings.build_model("supervisor")

    # Bedrock Guardrails (layer 1 of the Supervisor's three-layer defense -
    # see agents/supervisor/guardrails.py) are a Bedrock-specific concept,
    # so they're only applied when Bedrock is the active provider. This is
    # a no-op today either way, since get_guardrail_config() returns {}
    # until BEDROCK_GUARDRAIL_ID is set - see that module's TODO.
    guardrail_config = get_guardrail_config()
    if settings.model_provider == "bedrock" and guardrail_config:
        model.update_config(**guardrail_config)

    return Agent(
        model=model,
        system_prompt=SUPERVISOR_SYSTEM_PROMPT,
        tools=SUPERVISOR_TOOLS,
        name="supervisor",
        description="Top-level ERP assistant that routes to the Insights and Document specialists.",
    )


def handle_query(query: str, human_bearer_token: str | None = None) -> str:
    """Entry point a caller (e.g. an AgentCore Runtime handler) would use.

    Applies the scope gate (layer 2 of the three-layer defense) BEFORE the
    Supervisor agent is even constructed - an out-of-scope query never
    reaches the Supervisor's own model call, and therefore never reaches
    insights_agent_tool or document_agent_tool either.

    This local entry point is intentionally minimal: conversation/session
    state and streaming are separate concerns. AgentCore deployment uses
    agentcore_entrypoint.py; routing itself remains the Supervisor model's
    responsibility after the gate passes.
    """
    allowed, reason = is_in_scope(query)
    if not allowed:
        return (
            "I can only help with inventory, warehouses, orders, invoices, "
            "stock, suppliers, and document processing for this ERP system "
            f"({reason}). Let me know if you have a question in that area."
        )

    agent = build_supervisor_agent()
    with human_auth_scope(human_bearer_token):
        result = agent(query)
    return str(result)


if __name__ == "__main__":
    # Manual smoke run: `python -m agents.supervisor.agent`
    print(handle_query("What products are at risk of stocking out?"))
