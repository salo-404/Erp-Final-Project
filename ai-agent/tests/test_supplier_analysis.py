"""Tests for the on-demand supplier analysis narration (narration/supplier_analysis.py).

NOT an agents/ test - this is the "explain this supplier" feature, on
demand for one supplier at a time, distinct from
narration/control_tower.py's batch alert narration. The offline tests mock
the real backend (httpx.MockTransport, same convention as
tests/test_insights_agent.py's _patch_backend_client) and the model call, so
they check narrate_supplier() maps a real-shaped backend response into a
SupplierNarration correctly, and that an unknown supplier_id raises rather
than fabricating a result - no network, no credentials. The live test
narrates a real known supplier through a real model and a real backend, and
is skipped without both configured, same pattern as every other live
integration test in this suite (see tests/_helpers.py).
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from backend_client import BackendClient
from narration import supplier_analysis
from tests._helpers import backend_reachable, live_model_configured
from tools.mocks.supplier_mock_data import SupplierNotFoundError
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


async def _service_token_provider() -> str:
    return "fake-token"


def _patch_backend_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """Point narrate_supplier() at a BackendClient backed by
    httpx.MockTransport instead of the real network - same pattern as
    tests/test_insights_agent.py's _patch_backend_client(). Patches the name
    as bound inside narration.supplier_analysis (where `from backend_client
    import get_backend_client` already resolved it at import time).
    """
    test_client = BackendClient(
        base_url="http://backend.test",
        service_token_provider=_service_token_provider,
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(supplier_analysis, "get_backend_client", lambda: test_client)


# A real-shaped GET /suppliers/5/transactions response (Nordic Components
# AB) - a Supplier row with nested transactions -> items -> product, same
# shape SuppliersService.getTransactionHistory() actually returns.
_NORDIC_TRANSACTIONS_RESPONSE = {
    "id": 5,
    "name": "Nordic Components AB",
    "email": "sales@nordic-components.example",
    "leadTimeDays": 9,
    "isActive": True,
    "createdAt": "2026-05-01T00:00:00.000Z",
    "transactions": [
        {
            "id": 900,
            "type": "INCOMING",
            "status": "COMPLETED",
            "items": [
                {
                    "id": 1,
                    "productId": 201,
                    "quantity": 10,
                    "price": "34.50",
                    "product": {"id": 201, "name": "USB-C Docking Station", "category": "Docking Stations"},
                },
                {
                    "id": 2,
                    "productId": 202,
                    "quantity": 5,
                    "price": "12.00",
                    "product": {"id": 202, "name": "Wireless Mouse", "category": "Peripherals"},
                },
            ],
        },
    ],
}

# A real-shaped GET /supplier-intelligence/5/stats response.
_NORDIC_STATS_RESPONSE = {
    "supplierId": 5,
    "totalTransactions": 42,
    "completedTransactions": 40,
    "cancelledTransactions": 2,
    "cancellationRate": 0.047619047619047616,
    "averagePrice": 34.50,
    "pricedItemCount": 42,
    "onTimeDeliveryRate": 0.95,
    "evaluatedForOnTimeCount": 40,
    "purchaseFrequency": 3.5,
    "firstPurchaseDate": "2026-01-01T00:00:00.000Z",
    "lastPurchaseDate": "2026-08-01T00:00:00.000Z",
}


def _nordic_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/suppliers/5/transactions":
        return httpx.Response(200, json=_NORDIC_TRANSACTIONS_RESPONSE)
    if request.url.path == "/supplier-intelligence/5/stats":
        return httpx.Response(200, json=_NORDIC_STATS_RESPONSE)
    raise AssertionError(f"unexpected path {request.url.path}")


def test_narrate_supplier_maps_real_backend_stats_into_narration_with_mocked_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Offline - no credentials, no network. Mocks settings.build_model()
    and the backend client, so neither the real model SDK nor the real
    network is ever touched.
    """
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())
    _patch_backend_client(monkeypatch, _nordic_handler)

    narrated = supplier_analysis.narrate_supplier("5")

    assert isinstance(narrated, SupplierNarration)
    # Every stats field mapped from the real (mocked) backend response, not
    # regenerated by the model - only narrative/recommendation_context come
    # from the model.
    assert narrated.supplier_id == 5
    assert narrated.name == "Nordic Components AB"
    assert narrated.unit_cost == 34.50
    assert narrated.lead_time_days == 9
    assert narrated.reliability_score == 0.95
    assert narrated.overall_score is None
    assert narrated.recent_transaction_count == 42
    assert narrated.on_time_delivery_rate == 0.95
    assert narrated.product_categories == ["Docking Stations", "Peripherals"]
    # Generated fields present and exactly what the fake model returned.
    assert narrated.narrative == "Test narrative about this supplier's trade-offs."
    assert narrated.recommendation_context == "Test recommendation context, not a directive."


def test_narrate_supplier_accepts_string_id_and_converts_internally(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """narrate_supplier() takes supplier_id as a str (e.g. a CLI arg) and
    resolves it against the same int-keyed backend endpoints.
    """
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())
    _patch_backend_client(monkeypatch, _nordic_handler)

    narrated = supplier_analysis.narrate_supplier("5")

    assert narrated.supplier_id == 5
    assert narrated.name == "Nordic Components AB"


def test_narrate_supplier_handles_missing_optional_stats_without_fabricating(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A real supplier with no priced/on-time-evaluable transactions yet -
    unit_cost/reliability_score/on_time_delivery_rate must come back None,
    never a fabricated 0, same convention as
    agents/insights_agent/tools.py's compare_suppliers().
    """
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/suppliers/7/transactions":
            return httpx.Response(
                200,
                json={"id": 7, "name": "New Supplier Co", "leadTimeDays": None, "isActive": True, "transactions": []},
            )
        if request.url.path == "/supplier-intelligence/7/stats":
            return httpx.Response(
                200,
                json={
                    "supplierId": 7,
                    "totalTransactions": 0,
                    "completedTransactions": 0,
                    "cancelledTransactions": 0,
                    "cancellationRate": 0,
                    "averagePrice": None,
                    "pricedItemCount": 0,
                    "onTimeDeliveryRate": None,
                    "evaluatedForOnTimeCount": 0,
                    "purchaseFrequency": 0,
                    "firstPurchaseDate": None,
                    "lastPurchaseDate": None,
                },
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    narrated = supplier_analysis.narrate_supplier("7")

    assert narrated.unit_cost is None
    assert narrated.lead_time_days is None
    assert narrated.reliability_score is None
    assert narrated.overall_score is None
    assert narrated.on_time_delivery_rate is None
    assert narrated.recent_transaction_count == 0
    assert narrated.product_categories == []


def test_narrate_supplier_raises_for_unknown_supplier_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression-style check: an unknown supplier_id must raise, not
    silently fabricate a result - same principle as the document_id fix.
    """
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/suppliers/999999/transactions":
            return httpx.Response(404, json={"message": "Supplier with ID 999999 not found", "statusCode": 404})
        raise AssertionError(f"unexpected path {request.url.path}")

    _patch_backend_client(monkeypatch, handler)

    with pytest.raises(SupplierNotFoundError):
        supplier_analysis.narrate_supplier("999999")


def test_narrate_supplier_raises_for_non_numeric_supplier_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(supplier_analysis, "settings", _FakeSettings())

    with pytest.raises(ValueError):
        supplier_analysis.narrate_supplier("not-a-number")


def test_get_mock_supplier_stats_raises_for_unknown_id() -> None:
    """Offline sanity check on the (now narration-independent) mock helper
    itself - tools/mocks/supplier_mock_data.py is no longer narrate_supplier()'s
    data source (see narration/supplier_analysis.py), but it's still real,
    working code worth its own direct test.
    """
    from tools.mocks.supplier_mock_data import get_mock_supplier_stats

    with pytest.raises(SupplierNotFoundError):
        get_mock_supplier_stats(999999)


@pytest.mark.integration
@pytest.mark.skipif(
    not live_model_configured(),
    reason="No live model configured for MODEL_PROVIDER - skipping live supplier narration test",
)
@pytest.mark.skipif(
    not backend_reachable(),
    reason="No real backend reachable at BACKEND_URL - skipping live supplier narration test",
)
def test_narrate_supplier_live_for_a_real_backend_supplier() -> None:
    """Live - runs narrate_supplier() against a real supplier through the
    real backend and a real model. Requires a real Supplier row to exist;
    picks the first one from GET /suppliers rather than a hard-coded ID; see
    tests/_helpers.py for the reachability gate.
    """
    import asyncio

    from backend_client import get_backend_client

    client = get_backend_client()
    suppliers = asyncio.run(client.get("/suppliers"))
    if not suppliers:
        pytest.skip("No real suppliers exist in the reachable backend to narrate")
    real_supplier_id = suppliers[0]["id"]

    result = supplier_analysis.narrate_supplier(str(real_supplier_id))

    assert result.supplier_id == real_supplier_id
    assert result.name == suppliers[0]["name"]
    assert result.narrative.strip()
    assert result.recommendation_context.strip()
