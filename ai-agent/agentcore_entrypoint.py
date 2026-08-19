"""AWS Bedrock AgentCore Runtime entrypoint for the Supervisor agent.

This is Option A (SDK Integration) from Strands' official AgentCore
deployment guide: BedrockAgentCoreApp wraps the EXISTING Supervisor agent
(agents/supervisor/agent.py) as an HTTP service. No new agent, no new agent
logic - this file only adds a deployment shell around
build_supervisor_agent(), which already works today via
scripts/chat_locally.py for local, interactive use.

Separate from scripts/chat_locally.py: that's a stdin/stdout REPL for local
development only. This module is what actually gets deployed to AgentCore
Runtime - an HTTP service speaking the AgentCore invocation protocol
(POST /invocations), not a terminal chat loop.

Model-agnostic by construction: build_supervisor_agent() already resolves
its model via settings.build_model("supervisor") (see config/settings.py),
so this entrypoint works with whichever MODEL_PROVIDER is set in .env -
"openai", "ollama", or "bedrock" - completely independent of whether the
deploying AWS account/role even has Bedrock model-invoke permissions. Only
actually calling Bedrock (MODEL_PROVIDER=bedrock) needs those permissions;
the AgentCore Runtime *hosting* layer itself does not.

Local test (per the official guide's manual verification steps - see
README.md "Deploying to AgentCore Runtime" for the full walkthrough):

    python agentcore_entrypoint.py
    # in another terminal:
    curl -X POST http://localhost:8080/invocations \\
        -H "Content-Type: application/json" \\
        -d '{"prompt": "Which products are at risk of stocking out?"}'
"""

from __future__ import annotations

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from agents.supervisor.agent import build_supervisor_agent
from agents.supervisor.gate import is_in_scope

app = BedrockAgentCoreApp()

# Built ONCE at module load, not per-request - constructing the Supervisor
# (system prompt, tool registry, model client) on every HTTP invocation
# would be wasteful. The scope gate (is_in_scope) is deliberately NOT
# folded into this one-time build: it's a per-query classification, so it
# still runs fresh inside invoke() for every request - see that function.
_supervisor_agent = build_supervisor_agent()


@app.entrypoint
def invoke(payload: dict) -> dict:
    """AgentCore Runtime entrypoint - one HTTP invocation in, one JSON response out.

    Mirrors agents/supervisor/agent.py's handle_query(), but against the
    already-built _supervisor_agent above instead of rebuilding it on every
    call: runs the scope gate first (layer 2 of the Supervisor's
    three-layer defense - see agents/supervisor/prompts.py), and only runs
    the prompt through the Supervisor agent if it passes.

    Args:
        payload: The raw JSON request body. Must contain a "prompt" key
            with the user's query as a string.

    Returns:
        {"result": <the Supervisor's text response>} - either the
        Supervisor's real answer, or the gate's decline message if the
        prompt was out of scope.

    Raises:
        ValueError: If payload has no usable "prompt" string. The
            AgentCore framework catches this and returns it as a 500 with
            the error message - see bedrock_agentcore.runtime.app for that
            handling.
    """
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('payload must contain a non-empty "prompt" string')

    allowed, reason = is_in_scope(prompt)
    if not allowed:
        return {
            "result": (
                "I can only help with inventory, warehouses, orders, invoices, "
                "stock, suppliers, and document processing for this ERP system "
                f"({reason}). Let me know if you have a question in that area."
            )
        }

    response = _supervisor_agent(prompt)
    return {"result": str(response)}


if __name__ == "__main__":
    app.run()
