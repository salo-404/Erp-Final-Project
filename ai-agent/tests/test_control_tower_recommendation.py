"""Tests for narration/control_tower_recommendation.py - the Control Tower
"Recommend Solution" builder. Deterministic tool selection in Python (see
that module's docstring for why this replaced an earlier Agent/tool-calling
design that proved unreliable), with a one-shot model call only to phrase
the real result - same pattern as narration/control_tower.py's
narrate_alert().
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import narration.control_tower_recommendation as recommendation_module
from narration.control_tower_recommendation import (
    RECOMMENDATION_SYSTEM_PROMPT,
    _gather_evidence,
    build_recommendation,
)


def test_recommendation_prompt_forbids_hedging_and_fabricated_fields() -> None:
    """Guards against the real live bug: a response that fabricated a
    reorder threshold/consumption figure/pending-delivery status (none of
    which exist in any of the 3 tools' real output) and hedged between
    two options ("restock or transfer... check supplier options...")
    instead of reporting the one real decision already made in Python."""
    prompt = " ".join(RECOMMENDATION_SYSTEM_PROMPT.split())

    assert "already been looked up for you" in prompt
    assert "never mention a number, name, or fact that isn't literally present" in prompt.lower()
    assert "Never present two fixes as parallel options" in prompt
    assert "reflects exactly ONE real decision" in prompt


def test_recommendation_prompt_forbids_raw_ids_and_unnamed_references() -> None:
    """Guards against the real bug this was fixed for: the model rendering
    "product 34"/"warehouse 14" from a bare id field, or saying "another
    warehouse has a surplus" without naming which one - both now
    explicitly forbidden, on top of the evidence itself being enriched
    with *Name fields (see recommend_dead_stock_transfer()/
    recommend_stockout_fix()/recommend_alternative_supplier() in
    agents/insights_agent/tools.py)."""
    prompt = " ".join(RECOMMENDATION_SYSTEM_PROMPT.split())

    assert "never a bare numeric id" in prompt.lower()
    assert "productId" in prompt and "warehouseId" in prompt and "supplierId" in prompt
    assert "never say \"another warehouse has a surplus\"" in prompt.lower()
    assert "must never see one" in prompt.lower()


def test_gather_evidence_dead_stock_finds_the_matching_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_recommend_dead_stock_transfer() -> dict:
        return {
            "recommendations": [
                {"productId": 3, "sourceWarehouseId": 2, "onHand": 40, "recommendedTransfers": [{"destinationWarehouseId": 5, "quantity": 20}], "reason": "sold recently elsewhere"},
                {"productId": 99, "sourceWarehouseId": 2, "onHand": 10, "recommendedTransfers": [], "reason": "unrelated entry"},
            ],
        }

    monkeypatch.setattr(recommendation_module, "recommend_dead_stock_transfer", fake_recommend_dead_stock_transfer)

    evidence = asyncio.run(_gather_evidence("DEAD_STOCK", {"productId": 3, "warehouseId": 2}))

    assert evidence["productId"] == 3
    assert evidence["recommendedTransfers"] == [{"destinationWarehouseId": 5, "quantity": 20}]


def test_gather_evidence_dead_stock_raises_when_no_matching_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_recommend_dead_stock_transfer() -> dict:
        return {"recommendations": []}

    monkeypatch.setattr(recommendation_module, "recommend_dead_stock_transfer", fake_recommend_dead_stock_transfer)

    with pytest.raises(LookupError):
        asyncio.run(_gather_evidence("DEAD_STOCK", {"productId": 3, "warehouseId": 2}))


def test_gather_evidence_stockout_risk_calls_recommend_stockout_fix(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []

    async def fake_recommend_stockout_fix(*, product_id: int, warehouse_id: int) -> dict:
        calls.append({"product_id": product_id, "warehouse_id": warehouse_id})
        return {"productId": product_id, "warehouseId": warehouse_id, "action": "order_from_supplier", "transfer": None, "supplierRecommendation": {"supplierId": 7}, "reason": "no donor qualifies"}

    monkeypatch.setattr(recommendation_module, "recommend_stockout_fix", fake_recommend_stockout_fix)

    evidence = asyncio.run(_gather_evidence("STOCKOUT_RISK", {"productId": 3, "warehouseId": 2}))

    assert calls == [{"product_id": 3, "warehouse_id": 2}]
    assert evidence["action"] == "order_from_supplier"


def test_gather_evidence_overdue_transaction_calls_once_per_product(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []

    async def fake_recommend_alternative_supplier(*, product_id: int, exclude_supplier_id: int) -> dict:
        calls.append({"product_id": product_id, "exclude_supplier_id": exclude_supplier_id})
        return {"productId": product_id, "excludedSupplierId": exclude_supplier_id, "status": "alternative_recommended", "recommendedSupplier": {"supplierId": 9}}

    monkeypatch.setattr(recommendation_module, "recommend_alternative_supplier", fake_recommend_alternative_supplier)

    evidence = asyncio.run(_gather_evidence("OVERDUE_TRANSACTION", {"supplierId": 7, "productIds": [3, 5]}))

    assert calls == [
        {"product_id": 3, "exclude_supplier_id": 7},
        {"product_id": 5, "exclude_supplier_id": 7},
    ]
    assert evidence["excludedSupplierId"] == 7
    assert len(evidence["perProduct"]) == 2


def test_gather_evidence_rejects_unsupported_category() -> None:
    with pytest.raises(ValueError, match="Unsupported"):
        asyncio.run(_gather_evidence("CONSUMPTION_ANOMALY", {}))


def test_build_recommendation_gathers_evidence_then_narrates(monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end: build_recommendation() must call the deterministic
    evidence gatherer FIRST (never skippable, since it's plain Python, not
    a model tool-call decision) and hand its real result to the narration
    call - never the other way around, and never narrate without it."""
    gathered: list[tuple[str, dict]] = []

    async def fake_gather_evidence(category: str, alert: dict) -> dict:
        gathered.append((category, alert))
        return {"action": "order_from_supplier", "supplierRecommendation": {"supplierName": "Acme"}, "reason": "no donor qualifies"}

    narrated: list[tuple[str, dict]] = []

    async def fake_narrate(category: str, evidence: dict) -> str:
        narrated.append((category, evidence))
        return "I checked the other warehouses and none qualify, so order from Acme."

    monkeypatch.setattr(recommendation_module, "_gather_evidence", fake_gather_evidence)
    monkeypatch.setattr(recommendation_module, "_narrate", fake_narrate)

    text = asyncio.run(build_recommendation("STOCKOUT_RISK", {"productId": 3, "warehouseId": 2}))

    assert gathered == [("STOCKOUT_RISK", {"productId": 3, "warehouseId": 2})]
    assert narrated == [("STOCKOUT_RISK", {"action": "order_from_supplier", "supplierRecommendation": {"supplierName": "Acme"}, "reason": "no donor qualifies"})]
    assert text == "I checked the other warehouses and none qualify, so order from Acme."


def test_narrate_uses_structured_output_and_returns_the_recommendation_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeModel:
        async def structured_output(self, output_model, messages, system_prompt):
            assert system_prompt == RECOMMENDATION_SYSTEM_PROMPT
            yield {"output": output_model(recommendation="Real narrated text.")}

    monkeypatch.setattr(
        recommendation_module, "settings", SimpleNamespace(build_model=lambda role: FakeModel())
    )

    text = asyncio.run(recommendation_module._narrate("DEAD_STOCK", {"reason": "kept in place"}))

    assert text == "Real narrated text."
