"""Document specialist agent.

Standalone: this module can be imported and run entirely on its own, with no
dependency on the Supervisor -

    python -m agents.document_agent.agent

It is ALSO exposed as `document_agent_tool`, a @tool-wrapped function the
Supervisor imports and adds to its own tools list (the "Agents-as-Tools"
pattern - see agents/supervisor/agent.py).

document_agent_tool appends a [MATCHED_DATA] block to its returned text -
see _extract_matched_data() below. This exists to close a real gap: the
Supervisor only ever sees this function's return value as free text, and
threading concrete IDs (document_id, matched product_ids) through prose
alone was unreliable - the Supervisor would ask Insights a generic
question instead of checking the exact products a document was actually
about. The natural-language summary is unchanged; the block is a
machine-parseable addition, not a replacement.
"""

from __future__ import annotations

import json

from strands import Agent, tool

from agents.document_agent.prompts import DOCUMENT_SYSTEM_PROMPT
from agents.document_agent.tools import (
    approve_document_review,
    detect_duplicate_document,
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
    detect_duplicate_document,
]


def build_document_agent() -> Agent:
    """Construct a standalone Document Agent instance.

    Isolated from the Supervisor and Insights agent - can be built and run
    on its own for local testing. The model provider is decided entirely by
    settings.build_model() -
    see config/settings.py - so switching providers never touches this
    function.
    """
    model = settings.build_model("document")
    return Agent(
        model=model,
        system_prompt=DOCUMENT_SYSTEM_PROMPT,
        tools=DOCUMENT_TOOLS,
        callback_handler=None,
        name="document_agent",
        description="Document processing specialist for uploaded invoices and orders.",
    )


def _extract_matched_data(messages: list[dict]) -> dict | None:
    """Pull document_id, matched product_ids, and requested quantities out of this turn's tool activity.

    Walks the full conversation (tool_use + tool_result blocks) the Document
    agent just produced and returns the concrete identifiers a downstream
    caller (the Supervisor, passing work to Insights) actually needs -
    without relying on those identifiers surviving a trip through
    free-text prose.

    document_id comes from document-specific tool input. product_ids come
    only from RESOLVED resolve_document_product() results. Requested
    quantities come from those resolver results after the resolver derived
    them from get_document_review()'s stored extractedItems, or directly from
    a get_document_review() tool result. Model-supplied quantities are never
    trusted for this handoff.

    Returns:
        {"document_id": str, "product_ids": list[int], "requested_quantities":
        [{"product_id": int, "quantity": int}, ...]}, or None if no document
        tool was actually called this turn (nothing to report).
    """
    tool_names_by_id: dict[str, str] = {}
    tool_inputs_by_id: dict[str, dict] = {}
    document_id: str | None = None
    seen_document_ids: set[str] = set()
    product_ids: list[int] = []
    seen_product_ids: set[int] = set()
    quantity_by_raw_name: dict[str, int] = {}
    product_id_by_raw_name: dict[str, int] = {}

    def _add_product_id(value: object) -> None:
        if isinstance(value, int) and value not in seen_product_ids:
            seen_product_ids.add(value)
            product_ids.append(value)

    # Pass 1: map tool calls and capture the real document id.
    for message in messages:
        for block in message.get("content", []):
            tool_use = block.get("toolUse")
            if not tool_use:
                continue

            tool_use_id = tool_use.get("toolUseId")
            name = tool_use.get("name")
            tool_input = tool_use.get("input") or {}
            if tool_use_id:
                tool_names_by_id[tool_use_id] = name
                tool_inputs_by_id[tool_use_id] = tool_input

            input_document_id = tool_input.get("document_id")
            if isinstance(input_document_id, str):
                seen_document_ids.add(input_document_id)
                if document_id is None:
                    document_id = input_document_id

    if document_id is None or len(seen_document_ids) != 1:
        return None

    # Pass 2: pull exact IDs only from authoritative resolver results and
    # quantities from those calls or the stored review's extracted items.
    for message in messages:
        for block in message.get("content", []):
            tool_result = block.get("toolResult")
            if not tool_result:
                continue
            result_tool_use_id = tool_result.get("toolUseId")
            result_tool_name = tool_names_by_id.get(result_tool_use_id)
            if result_tool_name not in ("resolve_document_product", "get_document_review"):
                continue
            if tool_inputs_by_id.get(result_tool_use_id, {}).get("document_id") != document_id:
                continue

            for content_item in tool_result.get("content") or []:
                text = content_item.get("text")
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except (json.JSONDecodeError, TypeError):
                    continue

                if result_tool_name == "resolve_document_product":
                    if (
                        payload.get("status") != "RESOLVED"
                        or payload.get("documentId") != document_id
                    ):
                        continue
                    product_id = payload.get("productId")
                    raw_name = payload.get("productNameRaw")
                    _add_product_id(product_id)
                    if isinstance(raw_name, str) and isinstance(product_id, int):
                        product_id_by_raw_name[raw_name] = product_id
                    quantity = payload.get("requestedQuantity")
                    if (
                        isinstance(raw_name, str)
                        and isinstance(quantity, int)
                        and quantity > 0
                    ):
                        quantity_by_raw_name[raw_name] = quantity
                elif result_tool_name == "get_document_review":
                    if str(payload.get("id")) != document_id:
                        continue
                    for item in payload.get("extractedItems") or []:
                        raw_name = item.get("product")
                        quantity = item.get("quantity")
                        if (
                            isinstance(raw_name, str)
                            and isinstance(quantity, int)
                            and quantity > 0
                        ):
                            quantity_by_raw_name[raw_name] = quantity

    requested_quantities = [
        {"product_id": product_id_by_raw_name[raw_name], "quantity": quantity}
        for raw_name, quantity in quantity_by_raw_name.items()
        if raw_name in product_id_by_raw_name
    ]

    return {
        "document_id": document_id,
        "product_ids": product_ids,
        "requested_quantities": requested_quantities,
    }


@tool
def document_agent_tool(query: str) -> str:
    """Delegate pending-review lookup, document matching, advisory checks, or review decisions to the Document specialist agent.

    Args:
        query: The user's document-processing request, in natural language.
            Should mention whether the document is an invoice or an order
            when that context is available.

    Returns:
        The Document agent's text response, followed - when a document tool
        actually ran this turn - by a machine-parseable
        [MATCHED_DATA] {"document_id": "...", "product_ids": [...], "requested_quantities": [...]} [/MATCHED_DATA]
        block. This is an ADDITION, not a replacement: the prose summary is
        unchanged, so it still reads naturally on its own. The block exists
        so a caller like the Supervisor can extract concrete identifiers
        (e.g. to pass product_ids AND the actual requested quantities to
        insights_agent_tool for a real fulfillment/shortage check) without
        having to parse them back out of prose.
    """
    agent = build_document_agent()
    result = agent(query)
    text = str(result)

    matched_data = _extract_matched_data(agent.messages)
    if matched_data is not None:
        text += f"\n\n[MATCHED_DATA] {json.dumps(matched_data)} [/MATCHED_DATA]"

    return text


if __name__ == "__main__":
    # Manual smoke run: `python -m agents.document_agent.agent`
    standalone_agent = build_document_agent()
    response = standalone_agent(
        "A new invoice was just uploaded (doc_type=invoice). Process it and tell me what happened."
    )
    print(response)
