"""Insights specialist agent.

Standalone: this module can be imported and run entirely on its own, with no
dependency on the Supervisor -

    python -m agents.insights_agent.agent

It is ALSO exposed as `insights_agent_tool`, a @tool-wrapped function the
Supervisor imports and adds to its own tools list (the "Agents-as-Tools"
pattern - see agents/supervisor/agent.py).
"""

from __future__ import annotations

from strands import Agent, tool

from agents.insights_agent.prompts import INSIGHTS_SYSTEM_PROMPT
from agents.insights_agent.tools import (
    analyze_dead_stock,
    compare_suppliers,
    get_available_stock,
    get_consumption_anomalies,
    get_low_stock_products,
    get_open_purchase_orders,
    get_restock_recommendations,
    get_stockout_risk,
    get_transfer_recommendations,
    recommend_fulfillment_warehouse,
)
from config.settings import settings
from tools.query_database import query_database

INSIGHTS_TOOLS = [
    get_available_stock,
    get_low_stock_products,
    get_stockout_risk,
    get_restock_recommendations,
    get_transfer_recommendations,
    analyze_dead_stock,
    get_consumption_anomalies,
    compare_suppliers,
    get_open_purchase_orders,
    recommend_fulfillment_warehouse,
    query_database,
]


def build_insights_agent() -> Agent:
    """Construct a standalone Insights Agent instance.

    Isolated from the Supervisor and Document agent - can be built and run
    on its own for local testing. The model provider is decided entirely by
    settings.build_model() -
    see config/settings.py - so switching providers never touches this
    function.
    """
    model = settings.build_model("insights")
    return Agent(
        model=model,
        system_prompt=INSIGHTS_SYSTEM_PROMPT,
        tools=INSIGHTS_TOOLS,
        callback_handler=None,
        name="insights_agent",
        description="Inventory analytics and procurement specialist (stock, risk, suppliers, purchase orders).",
    )


@tool
def insights_agent_tool(query: str) -> str:
    """Delegate a question about inventory, stock levels, stockout risk, restocking, transfers, dead stock, consumption anomalies, suppliers, or purchase orders to the Insights specialist agent.

    Args:
        query: The user's inventory/procurement-related question, in natural language.

    Returns:
        The Insights agent's text response.
    """
    agent = build_insights_agent()
    result = agent(query)
    return str(result)


if __name__ == "__main__":
    # Manual smoke run: `python -m agents.insights_agent.agent`
    standalone_agent = build_insights_agent()
    response = standalone_agent("Which products are at risk of stocking out soon?")
    print(response)
