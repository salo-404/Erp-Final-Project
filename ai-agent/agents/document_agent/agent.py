"""Document specialist wired to the real NestJS review workflow."""

from __future__ import annotations

import json

from strands import Agent, tool

from agents.document_agent.prompts import DOCUMENT_SYSTEM_PROMPT
from agents.document_agent.tools import (
    approve_document_review,
    get_document_review,
    get_pending_document_reviews,
    reject_document_review,
    resolve_document_product,
    resolve_document_supplier,
)
from config.settings import settings

DOCUMENT_TOOLS = [
    get_pending_document_reviews,
    get_document_review,
    resolve_document_product,
    resolve_document_supplier,
    approve_document_review,
    reject_document_review,
]


def build_document_agent() -> Agent:
    """Construct the standalone Document Agent."""
    return Agent(
        model=settings.build_model("document"),
        system_prompt=DOCUMENT_SYSTEM_PROMPT,
        tools=DOCUMENT_TOOLS,
        name="document_agent",
        description="Document-review specialist for real pending review records and approval decisions.",
    )


def _extract_review_handoff(messages: list[dict]) -> dict | None:
    """Extract an unambiguous, machine-readable handoff from real review results."""
    tool_names_by_id: dict[str, str] = {}
    latest_review: dict | None = None

    for message in messages:
        for block in message.get("content", []):
            tool_use = block.get("toolUse")
            if tool_use and tool_use.get("toolUseId"):
                tool_names_by_id[tool_use["toolUseId"]] = tool_use.get("name", "")

    for message in messages:
        for block in message.get("content", []):
            tool_result = block.get("toolResult")
            if not tool_result:
                continue
            name = tool_names_by_id.get(tool_result.get("toolUseId"))
            if name not in {"get_document_review", "approve_document_review"}:
                continue
            for content_item in tool_result.get("content") or []:
                try:
                    payload = json.loads(content_item.get("text", ""))
                except (json.JSONDecodeError, TypeError):
                    continue
                if isinstance(payload, dict) and isinstance(payload.get("id"), int):
                    latest_review = payload

    if latest_review is None:
        return None

    transaction = latest_review.get("transaction") or {}
    confirmed_items = [
        {
            "product_id": item["productId"],
            "quantity": item["quantity"],
        }
        for item in transaction.get("items") or []
        if isinstance(item.get("productId"), int)
        and isinstance(item.get("quantity"), int)
    ]
    product_ids = list(dict.fromkeys(item["product_id"] for item in confirmed_items))

    handoff = {
        "review_id": latest_review["id"],
        "transaction_type": latest_review.get("transactionType"),
        "product_ids": product_ids,
        "items": confirmed_items,
        "requested_quantities": confirmed_items,
        "source_warehouse_id": transaction.get("sourceWarehouseId"),
        "destination_warehouse_id": transaction.get("destinationWarehouseId"),
        "supplier_id": transaction.get("supplierId"),
    }
    return handoff


@tool
def document_agent_tool(query: str) -> str:
    """Delegate listing, resolving, approving, or rejecting a real document review."""
    agent = build_document_agent()
    result = agent(query)
    text = str(result)
    handoff = _extract_review_handoff(agent.messages)
    if handoff is not None:
        text += f"\n\n[MATCHED_DATA] {json.dumps(handoff)} [/MATCHED_DATA]"
    return text


if __name__ == "__main__":
    standalone_agent = build_document_agent()
    print(standalone_agent("List the pending document reviews."))
