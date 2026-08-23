"""Focused tests for the real-backend Control Tower batch narration path."""

from __future__ import annotations

import asyncio
import inspect
from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError

from backend_client import BackendClient, ServiceUnavailable
from narration import control_tower
from scripts import run_control_tower_narration
from tests._helpers import live_model_configured
from tools.mocks.control_tower_mock_data import get_mock_control_tower_alerts
from tools.schemas.control_tower_schema import (
    Alert,
    AlertCategory,
    AlertSeverity,
    NarratedAlert,
)

_REFERENCE_DATE = "2026-08-15T09:00:00.000Z"


def _raw_alert(
    *,
    category: str = "DEAD_STOCK",
    severity: str = "INFO",
    data: dict | None = None,
) -> dict:
    return {
        "category": category,
        "severity": severity,
        "message": "Backend-authored alert message",
        "data": data if data is not None else {"productId": 5, "warehouseId": 1},
        "referenceDate": _REFERENCE_DATE,
    }


class _FakeModel:
    def __init__(self) -> None:
        self.messages = None
        self.system_prompt = None

    async def structured_output(self, output_model, messages, system_prompt=None, **kwargs):
        self.messages = messages
        self.system_prompt = system_prompt
        yield {
            "output": SimpleNamespace(
                narrative="Concise narration based on backend evidence.",
                proposed_action="Review the backend recommendation.",
            )
        }


class _FakeSettings:
    def __init__(self, model: _FakeModel) -> None:
        self.model = model

    def build_model(self, agent_name: str) -> _FakeModel:
        assert agent_name == "narration"
        return self.model


def test_alert_schema_matches_exact_frozen_backend_enums() -> None:
    assert {category.value for category in AlertCategory} == {
        "DEAD_STOCK",
        "CONSUMPTION_ANOMALY",
        "STOCKOUT_RISK",
        "OVERDUE_TRANSACTION",
        "PENDING_DOCUMENT_REVIEW",
        "RESTOCK_RECOMMENDATION",
        "TRANSFER_RECOMMENDATION",
    }
    assert {severity.value for severity in AlertSeverity} == {"CRITICAL", "WARNING", "INFO"}


def test_fetch_control_tower_alerts_uses_real_path_and_cached_service_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token_calls = 0
    requests: list[httpx.Request] = []

    async def service_token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "service-cognito-token"

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.method == "GET"
        assert request.url.path == "/control-tower/alerts"
        assert request.headers["Authorization"] == "Bearer service-cognito-token"
        return httpx.Response(200, json=[_raw_alert()])

    client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=service_token_provider,
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(control_tower, "get_backend_client", lambda: client)

    async def fetch_twice() -> tuple[list[Alert], list[Alert]]:
        return await control_tower.fetch_control_tower_alerts(), await control_tower.fetch_control_tower_alerts()

    first, second = asyncio.run(fetch_twice())

    assert len(first) == len(second) == 1
    assert token_calls == 1
    assert len(requests) == 2
    assert isinstance(first[0].referenceDate, datetime)


def test_fetch_control_tower_alerts_inherits_one_401_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tokens = iter(("expired-service-token", "fresh-service-token"))
    seen_authorizations: list[str] = []

    async def service_token_provider() -> str:
        return next(tokens)

    def handler(request: httpx.Request) -> httpx.Response:
        seen_authorizations.append(request.headers["Authorization"])
        if len(seen_authorizations) == 1:
            return httpx.Response(401, json={"message": "expired"})
        return httpx.Response(200, json=[_raw_alert()])

    client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=service_token_provider,
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(control_tower, "get_backend_client", lambda: client)

    alerts = asyncio.run(control_tower.fetch_control_tower_alerts())

    assert len(alerts) == 1
    assert seen_authorizations == [
        "Bearer expired-service-token",
        "Bearer fresh-service-token",
    ]


@pytest.mark.parametrize("severity", list(AlertSeverity))
def test_narration_preserves_category_severity_reference_message_and_data(
    monkeypatch: pytest.MonkeyPatch,
    severity: AlertSeverity,
) -> None:
    model = _FakeModel()
    monkeypatch.setattr(control_tower, "settings", _FakeSettings(model))
    alert = Alert.model_validate(
        _raw_alert(
            category="DEAD_STOCK",
            severity=severity.value,
            data={
                "productId": 5,
                "lastMovementAt": "2026-08-10T09:00:00.000Z",
                "lastOutgoingMovementAt": "2026-06-01T09:00:00.000Z",
                "daysSinceLastOutgoingMovement": 75,
            },
        )
    )

    narrated = control_tower.narrate_alert(alert)

    assert isinstance(narrated, NarratedAlert)
    assert narrated.category is alert.category
    assert narrated.severity is severity
    assert narrated.message == alert.message
    assert narrated.data == alert.data
    assert narrated.referenceDate == alert.referenceDate
    prompt_text = model.messages[0]["content"][0]["text"]
    assert alert.message in prompt_text
    assert "lastOutgoingMovementAt" in prompt_text
    assert alert.referenceDate.isoformat() in prompt_text


@pytest.mark.parametrize(
    ("category", "data"),
    [
        (
            "RESTOCK_RECOMMENDATION",
            {
                "recommendedQuantity": 25,
                "reason": "purchase_required",
                "riskLevel": "AT_RISK",
                "projectedRiskLevel": "AT_RISK",
            },
        ),
        (
            "TRANSFER_RECOMMENDATION",
            {
                "fromWarehouseId": 3,
                "toWarehouseId": 2,
                "transferQuantity": 15,
                "sourceIsDeadStock": True,
                "destinationRiskLevel": "AT_RISK",
            },
        ),
    ],
)
def test_recommendation_values_are_passed_through_unchanged(
    monkeypatch: pytest.MonkeyPatch,
    category: str,
    data: dict,
) -> None:
    monkeypatch.setattr(control_tower, "settings", _FakeSettings(_FakeModel()))
    alert = Alert.model_validate(_raw_alert(category=category, severity="WARNING", data=data))

    result = control_tower.narrate_alert(alert)

    assert result.data == data


def test_narration_prompt_preserves_backend_business_ownership_and_read_only_review() -> None:
    prompt = " ".join(control_tower.NARRATION_SYSTEM_PROMPT.split())
    assert "Do not alter, reinterpret, upgrade, downgrade" in prompt
    assert "Do not perform business calculations, create thresholds" in prompt
    assert "lastOutgoingMovementAt/daysSinceLastOutgoingMovement" in prompt
    assert "must not be described as customer demand" in prompt
    assert "accept the backend classification and dates" in prompt
    assert "PENDING_DOCUMENT_REVIEW is read-only and informational" in prompt
    assert "never approve, reject" in prompt
    assert "Never calculate a different recommendation" in prompt
    assert "claim an email/notification was sent" in prompt


def test_empty_backend_alert_list_is_clean_and_does_not_call_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def service_token_provider() -> str:
        return "service-token"

    client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=service_token_provider,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[])),
    )
    monkeypatch.setattr(control_tower, "get_backend_client", lambda: client)

    alerts = asyncio.run(control_tower.fetch_control_tower_alerts())
    narrated = control_tower.narrate_all_alerts(alerts)

    assert alerts == []
    assert narrated == []


@pytest.mark.parametrize(
    "invalid_alert",
    [
        _raw_alert(category="UNKNOWN_CATEGORY"),
        _raw_alert(severity="HIGH"),
        {**_raw_alert(), "message": ""},
        {key: value for key, value in _raw_alert().items() if key != "referenceDate"},
        {**_raw_alert(), "inventedTopLevelField": True},
    ],
)
def test_malformed_backend_alert_fails_validation_honestly(
    monkeypatch: pytest.MonkeyPatch,
    invalid_alert: dict,
) -> None:
    async def service_token_provider() -> str:
        return "service-token"

    client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=service_token_provider,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[invalid_alert])),
    )
    monkeypatch.setattr(control_tower, "get_backend_client", lambda: client)

    with pytest.raises(ValidationError):
        asyncio.run(control_tower.fetch_control_tower_alerts())


def test_backend_failure_propagates_without_mock_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def service_token_provider() -> str:
        return "service-token"

    client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=service_token_provider,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(503, json={"message": "alert aggregation unavailable"})
        ),
    )
    monkeypatch.setattr(control_tower, "get_backend_client", lambda: client)

    with pytest.raises(ServiceUnavailable, match="alert aggregation unavailable"):
        asyncio.run(control_tower.fetch_control_tower_alerts())


def test_production_control_tower_path_has_no_mock_or_human_auth_dependency() -> None:
    production_source = inspect.getsource(control_tower) + inspect.getsource(run_control_tower_narration)
    assert "tools.mocks" not in production_source
    assert "get_mock_control_tower_alerts" not in production_source
    assert "HumanAuthenticatedBackendClient" not in production_source
    assert "human_auth_scope" not in production_source


def test_test_fixture_set_matches_every_real_backend_category() -> None:
    alerts = get_mock_control_tower_alerts()
    assert {alert.category for alert in alerts} == set(AlertCategory)
    assert all(isinstance(alert, Alert) for alert in alerts)


@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping live narration test",
)
def test_narrate_all_alerts_produces_narratives_for_backend_shaped_fixtures() -> None:
    alerts = get_mock_control_tower_alerts()
    narrated = control_tower.narrate_all_alerts(alerts)

    assert len(narrated) == len(alerts)
    for original, result in zip(alerts, narrated):
        assert result.category == original.category
        assert result.severity == original.severity
        assert result.message == original.message
        assert result.data == original.data
        assert result.referenceDate == original.referenceDate
        assert result.narrative.strip()
        assert result.proposed_action.strip()
