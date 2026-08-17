"""Tests for the Control Tower narration layer (narration/control_tower.py).

NOT an agents/ test - Control Tower is explicitly not a fourth agent. The
offline test mocks the model call entirely (no credentials, no network) and
checks narrate_alert() maps an Alert into a NarratedAlert correctly. The
live test actually narrates the full mock alert set through a real model
and is skipped without one configured, same pattern as every other live
test in this suite (see tests/_helpers.py).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from narration import control_tower
from tests._helpers import live_model_configured
from tools.mocks.control_tower_mock_data import get_mock_control_tower_alerts
from tools.schemas.control_tower_schema import Alert, AlertCategory, AlertSeverity, NarratedAlert


class _FakeModel:
    """Stands in for a real strands Model - no network, no credentials.

    Mimics only the one method narrate_alert() actually calls:
    .structured_output(), an async generator whose last yielded event is
    {"output": <object with .narrative and .proposed_action>}. A plain
    SimpleNamespace is enough - narrate_alert() only reads those two
    attributes off whatever comes back, so there's no need to construct a
    real _NarrationFields instance here.
    """

    async def structured_output(self, output_model, messages, system_prompt=None, **kwargs):
        yield {
            "output": SimpleNamespace(
                narrative="Test narrative describing the alert.",
                proposed_action="Test proposed action to take.",
            )
        }


class _FakeSettings:
    """Stands in for config.settings.settings - returns _FakeModel regardless of agent_name."""

    def build_model(self, agent_name: str) -> _FakeModel:
        return _FakeModel()


def test_narrate_alert_maps_alert_into_narrated_alert_with_mocked_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Offline - no credentials, no network. Mocks settings.build_model() at
    the point narration/control_tower.py uses it, so the real model classes
    (and their optional SDK dependencies) are never touched.
    """
    monkeypatch.setattr(control_tower, "settings", _FakeSettings())

    alert = Alert(
        id="alert-test-001",
        category=AlertCategory.LOW_STOCK,
        severity=AlertSeverity.HIGH,
        evidence={"productId": 102, "onHand": 12, "reorderThreshold": 25, "deficit": 13},
        product_id=102,
        warehouse_id=1,
    )

    narrated = control_tower.narrate_alert(alert)

    assert isinstance(narrated, NarratedAlert)
    # Every original field passed through completely unchanged - the model
    # never regenerates these, only narrative/proposed_action.
    assert narrated.id == alert.id
    assert narrated.category == alert.category
    assert narrated.severity == alert.severity
    assert narrated.evidence == alert.evidence
    assert narrated.product_id == alert.product_id
    assert narrated.warehouse_id == alert.warehouse_id
    # Generated fields present and exactly what the fake model returned.
    assert narrated.narrative == "Test narrative describing the alert."
    assert narrated.proposed_action == "Test proposed action to take."


def test_narrate_all_alerts_calls_narrate_alert_per_item(monkeypatch: pytest.MonkeyPatch) -> None:
    """Offline - confirms the batch entry point narrates every alert, in order."""
    monkeypatch.setattr(control_tower, "settings", _FakeSettings())

    alerts = [
        Alert(id="a", category=AlertCategory.LOW_STOCK, severity=AlertSeverity.LOW, evidence={}),
        Alert(id="b", category=AlertCategory.STOCKOUT_RISK, severity=AlertSeverity.CRITICAL, evidence={}),
    ]

    narrated = control_tower.narrate_all_alerts(alerts)

    assert [n.id for n in narrated] == ["a", "b"]
    assert all(isinstance(n, NarratedAlert) for n in narrated)
    assert all(n.narrative and n.proposed_action for n in narrated)


def test_mock_alert_set_covers_every_category() -> None:
    """Offline sanity check on the mock data itself, independent of narration."""
    alerts = get_mock_control_tower_alerts()
    assert len(alerts) >= 6
    assert {alert.category for alert in alerts} == set(AlertCategory)
    assert all(isinstance(alert, Alert) for alert in alerts)


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping live narration test",
)
def test_narrate_all_alerts_produces_narratives_for_every_mock_alert() -> None:
    """Live - runs the real batch entry point against the real mock alert set."""
    alerts = get_mock_control_tower_alerts()

    narrated = control_tower.narrate_all_alerts(alerts)

    assert len(narrated) == len(alerts)
    for original, result in zip(alerts, narrated):
        assert result.id == original.id
        assert result.category == original.category
        assert result.severity == original.severity
        assert result.evidence == original.evidence
        assert result.narrative.strip(), f"Empty narrative for alert {result.id!r}"
        assert result.proposed_action.strip(), f"Empty proposed_action for alert {result.id!r}"
