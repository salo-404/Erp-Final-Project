"""Supervisor agent - Agents-as-Tools pattern.

Imports the Insights specialist agent as a @tool-wrapped function and
attaches it to a single top-level Agent. Insights remains a fully
independent module (see agents/insights_agent/agent.py) - the Supervisor
merely wraps it.

The Document agent (agents/document_agent/) still exists as real, working
code - it is used standalone elsewhere in the project, outside this
Supervisor - but is deliberately NOT wired into the Supervisor's routing.
Registering document_agent_tool here would mean every Supervisor call pays
token cost for a tool it can never legitimately use, and the model has to
weigh a routing option that leads nowhere. See git history around
2026-08-25 ("detangle Document from Supervisor routing") for the reasoning.

Before any of that, handle_query() runs the scope gate (agents/supervisor/gate.py)
- a separate, small classification call that rejects obviously out-of-scope
queries before the Supervisor agent is even constructed, so they never
reach the specialist tool at all.

Routing after the gate is intentionally model-driven: the Supervisor prompt
and the specialist tool description direct the model to Insights. There is
deliberately no duplicate keyword router. See tests/test_supervisor_wiring.py
for the routing contract and tests/test_gate.py for the gate's tests.
"""

from __future__ import annotations

from strands import Agent

from request_context import human_auth_scope

from agents.insights_agent.agent import insights_agent_tool
from agents.supervisor.gate import is_in_scope
from agents.supervisor.guardrails import get_guardrail_config
from agents.supervisor.prompts import SUPERVISOR_SYSTEM_PROMPT
from config.settings import settings

SUPERVISOR_TOOLS = [
    insights_agent_tool,
]


def build_supervisor_agent(session_manager: object | None = None) -> Agent:
    """Construct the top-level Supervisor Agent.

    Wraps exactly one specialist (Insights) as a tool. The Document agent
    is real, working code but intentionally not registered here - see this
    module's docstring. New inventory/procurement capabilities belong
    inside the Insights agent's tools.

    The model provider (OpenAI for local dev, Bedrock for
    production) is decided entirely by settings.build_model() - see
    config/settings.py - so switching providers never touches this
    function, matching the same pattern already used by
    build_insights_agent().
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
        callback_handler=None,
        name="supervisor",
        description="Top-level ERP assistant that routes to the Insights specialist.",
        session_manager=session_manager,
    )


def handle_query(query: str, human_bearer_token: str | None = None) -> str:
    """Entry point a caller (e.g. an AgentCore Runtime handler) would use.

    Applies the scope gate (layer 2 of the three-layer defense) BEFORE the
    Supervisor agent is even constructed - an out-of-scope query never
    reaches the Supervisor's own model call, and therefore never reaches
    insights_agent_tool either.

    This local entry point is intentionally minimal: conversation/session
    state and streaming are separate concerns. AgentCore deployment uses
    agentcore_entrypoint.py; routing itself remains the Supervisor model's
    responsibility after the gate passes.
    """
    allowed, reason, internal_error = is_in_scope(query)
    if not allowed:
        if internal_error:
            # reason is already the standalone generic fallback message
            # here (see gate.is_in_scope) - never grafted into the normal
            # decline template below, and never containing raw exception
            # details.
            return reason
        return (
            "I can only help with inventory, warehouses, orders, invoices, "
            f"stock, and suppliers for this ERP system ({reason}). Let me "
            "know if you have a question in that area."
        )

    agent = build_supervisor_agent()
    with human_auth_scope(human_bearer_token):
        result = agent(query)
    return str(result)


if __name__ == "__main__":
    # Manual smoke run: `python -m agents.supervisor.agent`
    print(handle_query("What products are at risk of stocking out?"))
