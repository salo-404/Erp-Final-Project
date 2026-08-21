"""Offline tests for real Control Tower fetching and narration."""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from pydantic import ValidationError

from narration import control_tower
from tools.schemas.control_tower_schema import (
    Alert,
    AlertCategory,
    AlertSeverity,
    NarratedAlert,
)

REAL_CATEGORIES = {
    "DEAD_STOCK", "CONSUMPTION_ANOMALY", "STOCKOUT_RISK",
    "OVERDUE_TRANSACTION", "PENDING_DOCUMENT_REVIEW",
    "RESTOCK_RECOMMENDATION", "TRANSFER_RECOMMENDATION",
}
REAL_SEVERITIES = {"CRITICAL", "WARNING", "INFO"}


def raw_alert(category="DEAD_STOCK", severity="INFO"):
    return {
        "category": category,
        "severity": severity,
        "message": "Backend-generated alert message",
        "data": {
            "productId": 42,
            "warehouseId": 2,
            "onHand": 10,
            "lastMovementAt": "2026-08-20T00:00:00.000Z",
            "lastOutgoingMovementAt": "2026-05-01T00:00:00.000Z",
            "daysSinceLastOutgoingMovement": 112,
        },
        "referenceDate": "2026-08-21T00:00:00.000Z",
    }


class _RecordingModel:
    def __init__(self):
        self.messages = None

    async def structured_output(self, output_model, messages, system_prompt=None, **kwargs):
        self.messages = messages
        yield {"output": SimpleNamespace(
            narrative="Backend evidence explained.",
            proposed_action="Review the alert evidence.",
        )}


class _FakeSettings:
    def __init__(self, model):
        self.model = model

    def build_model(self, agent_name):
        assert agent_name == "narration"
        return self.model


def test_get_control_tower_alerts_calls_exact_backend_endpoint_and_query():
    client = Mock()
    client.get.return_value = [raw_alert()]
    with patch("narration.control_tower.BackendHttpClient", return_value=client):
        result = control_tower.get_control_tower_alerts(60, 30, 50, "2026-08-21T00:00:00Z")
    client.get.assert_called_once_with(
        "/control-tower/alerts",
        query={
            "deadStockInactivityDays": 60,
            "consumptionWindowDays": 30,
            "consumptionThresholdPercent": 50,
            "referenceDate": "2026-08-21T00:00:00Z",
        },
    )
    assert result[0].data == raw_alert()["data"]


@pytest.mark.parametrize("category", sorted(REAL_CATEGORIES))
def test_every_real_category_validates(category):
    assert Alert.model_validate(raw_alert(category=category)).category.value == category


@pytest.mark.parametrize("severity", sorted(REAL_SEVERITIES))
def test_every_real_severity_validates(severity):
    assert Alert.model_validate(raw_alert(severity=severity)).severity.value == severity


@pytest.mark.parametrize(
    "category", ["low_stock", "expiring_inventory", "invoice_discrepancy", "order_discrepancy"]
)
def test_old_mock_categories_are_rejected(category):
    with pytest.raises(ValidationError):
        Alert.model_validate(raw_alert(category=category))


def test_narration_preserves_backend_fields_and_does_not_recalculate_severity(monkeypatch):
    model = _RecordingModel()
    monkeypatch.setattr(control_tower, "settings", _FakeSettings(model))
    alert = Alert.model_validate(raw_alert(category="STOCKOUT_RISK", severity="INFO"))
    result = control_tower.narrate_alert(alert)
    assert isinstance(result, NarratedAlert)
    assert result.category == alert.category
    assert result.severity == AlertSeverity.INFO
    assert result.message == alert.message
    assert result.data == alert.data
    assert result.referenceDate == alert.referenceDate


def test_dead_stock_prompt_uses_outgoing_customer_consumption_semantics():
    prompt = control_tower._build_narration_prompt(Alert.model_validate(raw_alert()))
    assert "lastOutgoingMovementAt/daysSinceLastOutgoingMovement" in prompt
    assert "Do not treat generic lastMovementAt" in prompt
    assert "customer consumption" in prompt


def test_active_control_tower_path_has_no_mock_import_or_severity_mapping():
    source = inspect.getsource(control_tower)
    assert "tools.mocks" not in source
    assert "get_mock_control_tower_alerts" not in source
    assert "SEVERITY_ORDER" not in source
    assert set(AlertCategory(item).value for item in REAL_CATEGORIES) == REAL_CATEGORIES
    assert set(AlertSeverity(item).value for item in REAL_SEVERITIES) == REAL_SEVERITIES
