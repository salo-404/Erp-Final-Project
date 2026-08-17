"""Tests for the on-demand supplier analysis narration (narration/supplier_analysis.py).

NOT an agents/ test - this is the "explain this supplier" feature, on
demand for one supplier at a time, distinct from
narration/control_tower.py's batch alert narration. The offline tests mock
the model call entirely (no credentials, no network) and check
narrate_supplier() maps SupplierStats into a SupplierNarration correctly,
and that an unknown supplier_id raises rather than fabricating a result.
The live test narrates a real known supplier through a real model and is
skipped without one configured, same pattern as every other live test in
this suite (see tests/_helpers.py).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from narration import supplier_analysis
from tests._helpers import live_model_configured
from tools.mocks.supplier_mock_data import SupplierNotFoundError, get_mock_supplier_stats
from tools.schemas.supplier_schema import SupplierNarration


class _FakeModel:
    """Stands in for a real strands Model - no network, no credentials.

    Mimics only .structured_output(), same pattern as
    tests/test_control_tower_narration.py's _FakeModel.
    """

    async def structured_output(self, output_model, messages, system_prompt=None, **kwargs):
        yield {
            "output": SimpleNamespace(
                narrative="Test narrative about this supplier's trade-offs.",
                recommendation_context="Test recommendation context, not a directive.",
            )
        }


class _FakeSettings:
    """Stands in for config.settings.settings - returns _FakeModel regardless of agent_name."""

    def build_model(self, agent_name: str) -> _FakeModel:
        return _FakeModel()


def test_narrate_supplier_maps_stats_into_narration_with_mocked_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Offline - no credentials, no network. Mocks settings.build_model() at
    the point narration/supplier_analysis.py uses it, so the real model
    classes (and their optional SDK dependencies) are never touched.
    """
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())

    stats = get_mock_supplier_stats(5)  # Nordic Components AB - known real mock supplier

    narrated = supplier_analysis.narrate_supplier("5")

    assert isinstance(narrated, SupplierNarration)
    # Every original stats field passed through completely unchanged - the
    # model never regenerates these, only narrative/recommendation_context.
    assert narrated.supplier_id == stats.supplier_id
    assert narrated.name == stats.name
    assert narrated.unit_cost == stats.unit_cost
    assert narrated.lead_time_days == stats.lead_time_days
    assert narrated.reliability_score == stats.reliability_score
    assert narrated.overall_score == stats.overall_score
    assert narrated.recent_transaction_count == stats.recent_transaction_count
    assert narrated.on_time_delivery_rate == stats.on_time_delivery_rate
    assert narrated.product_categories == stats.product_categories
    # Generated fields present and exactly what the fake model returned.
    assert narrated.narrative == "Test narrative about this supplier's trade-offs."
    assert narrated.recommendation_context == "Test recommendation context, not a directive."


def test_narrate_supplier_accepts_string_id_and_converts_internally(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """narrate_supplier() takes supplier_id as a str (e.g. a CLI arg) and
    resolves it against the same int-keyed mock data get_mock_supplier_stats() uses.
    """
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())

    narrated = supplier_analysis.narrate_supplier("12")

    assert narrated.supplier_id == 12
    assert narrated.name == "Rapid Source Trading"


def test_narrate_supplier_raises_for_unknown_supplier_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression-style check: an unknown supplier_id must raise, not
    silently fabricate a result - same principle as the document_id fix.
    """
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())

    with pytest.raises(SupplierNotFoundError):
        supplier_analysis.narrate_supplier("999999")


def test_narrate_supplier_raises_for_non_numeric_supplier_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())

    with pytest.raises(ValueError):
        supplier_analysis.narrate_supplier("not-a-number")


def test_get_mock_supplier_stats_raises_for_unknown_id() -> None:
    """Offline sanity check on the mock data itself, independent of narration."""
    with pytest.raises(SupplierNotFoundError):
        get_mock_supplier_stats(999999)


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping live supplier narration test",
)
def test_narrate_supplier_live_for_a_known_supplier() -> None:
    """Live - runs narrate_supplier() against a real known mock supplier."""
    result = supplier_analysis.narrate_supplier("5")

    assert result.supplier_id == 5
    assert result.name == "Nordic Components AB"
    assert result.narrative.strip()
    assert result.recommendation_context.strip()
