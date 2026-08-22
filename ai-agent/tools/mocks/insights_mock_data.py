"""Mock fixtures still genuinely used by the Insights agent's test suite.

12 of 13 insights_agent tools are wired to the real backend now (see
agents/insights_agent/tools.py's own module docstring) - their old mock
functions were deleted as dead code during the pre-handoff cleanup pass
(2026-08-22). Three things remain here, each for a real, still-current
reason:

  - get_dead_stock_entries_mock()/get_outgoing_movements_mock(): kept as
    realistic fixture data for OFFLINE PURE-LOGIC tests of
    recommend_dead_stock_transfer's private helpers
    (_qualifying_warehouses_by_recency, _compute_recommended_transfers,
    _build_dead_stock_transfer_reason in agents/insights_agent/tools.py) -
    those helpers are pure functions with no backend call of their own,
    so feeding them realistic fixture rows directly (rather than standing
    up an httpx.MockTransport backend double) is the simplest way to
    exercise their real logic offline. See tests/test_insights_agent.py.
  - draft_purchase_order_mock(): draft_purchase_order is the one
    insights_agent tool that is INTENTIONALLY, PERMANENTLY mocked - no
    proposal-only backend endpoint exists (the real backend only has
    createIncoming(), which actually executes a purchase, not a draft).
    Genuinely called from real tool code
    (agents/insights_agent/tools.py::draft_purchase_order).
"""

from __future__ import annotations

from datetime import datetime, timedelta

_NOW = datetime(2026, 8, 15, 9, 0, 0)


def get_dead_stock_entries_mock() -> dict:
    """Raw dead-stock entries as GET /stock-insights/dead-stock actually returns them.

    Mirrors the REAL backend's DeadStockEntry shape (productId,
    warehouseId, onHand, daysSinceLastOutgoingMovement) confirmed against
    backend/src/stock-insights/stock-insights.service.ts, since
    recommend_dead_stock_transfer composes real-backend-shaped data
    directly. Five entries, one per recommend_dead_stock_transfer test
    scenario: 501 (one qualifying warehouse), 502 (multiple qualifying,
    even split), 503 (zero qualifying), 504 (odd onHand, one qualifying),
    505 (odd onHand, multiple qualifying - remainder split).
    """
    return {
        "items": [
            {"productId": 501, "warehouseId": 3, "onHand": 100, "daysSinceLastOutgoingMovement": 75},
            {"productId": 502, "warehouseId": 3, "onHand": 100, "daysSinceLastOutgoingMovement": 90},
            {"productId": 503, "warehouseId": 3, "onHand": 80, "daysSinceLastOutgoingMovement": 120},
            {"productId": 504, "warehouseId": 3, "onHand": 101, "daysSinceLastOutgoingMovement": 62},
            {"productId": 505, "warehouseId": 4, "onHand": 101, "daysSinceLastOutgoingMovement": 200},
        ],
        "asOf": _NOW.isoformat(),
    }


def get_outgoing_movements_mock(product_id: int, date_from: datetime) -> list[dict]:
    """Raw OUTGOING stock movements for one product since date_from.

    Stands in for GET /stock-movements/ledger?productId=..&type=OUTGOING&
    dateFrom=.. - a bare list, matching the real getLedger()'s actual
    return shape (Promise<StockMovement[]>, no items/asOf wrapper).

    date_from is accepted for signature parity with the real endpoint;
    every fixture row below already falls inside
    recommend_dead_stock_transfer's 60-day lookback, so no additional
    filtering happens here - this fixture represents "what the backend
    would already have filtered down to".

    Keyed by product_id so each recommend_dead_stock_transfer test scenario
    gets independent, realistic movement history:
      - 501: warehouse 1 only -> one qualifying warehouse.
      - 502: warehouses 1 and 2 -> multiple qualifying, splits evenly.
      - 503: only a movement in warehouse 3 - the DEAD-STOCK warehouse
        itself - proving self-exclusion (it must not count as a qualifying
        OTHER warehouse); no other warehouse sold it, so zero qualifying.
      - 504: warehouse 1 only -> one qualifying warehouse, odd onHand.
      - 505: warehouses 1, 2, 3 at different recencies -> multiple
        qualifying with an uneven split, exercising the most-recent-sale-
        first remainder tie-break.
    """
    _ = date_from  # signature parity only; fixture rows are pre-filtered
    movements_by_product: dict[int, list[dict]] = {
        501: [
            {
                "productId": 501,
                "warehouseId": 1,
                "type": "OUTGOING",
                "quantity": 4,
                "createdAt": (_NOW - timedelta(days=10)).isoformat(),
            },
        ],
        502: [
            {
                "productId": 502,
                "warehouseId": 1,
                "type": "OUTGOING",
                "quantity": 6,
                "createdAt": (_NOW - timedelta(days=5)).isoformat(),
            },
            {
                "productId": 502,
                "warehouseId": 2,
                "type": "OUTGOING",
                "quantity": 3,
                "createdAt": (_NOW - timedelta(days=12)).isoformat(),
            },
        ],
        503: [
            {
                "productId": 503,
                "warehouseId": 3,
                "type": "OUTGOING",
                "quantity": 2,
                "createdAt": (_NOW - timedelta(days=15)).isoformat(),
            },
        ],
        504: [
            {
                "productId": 504,
                "warehouseId": 1,
                "type": "OUTGOING",
                "quantity": 9,
                "createdAt": (_NOW - timedelta(days=8)).isoformat(),
            },
        ],
        505: [
            {
                "productId": 505,
                "warehouseId": 1,
                "type": "OUTGOING",
                "quantity": 5,
                "createdAt": (_NOW - timedelta(days=5)).isoformat(),
            },
            {
                "productId": 505,
                "warehouseId": 2,
                "type": "OUTGOING",
                "quantity": 7,
                "createdAt": (_NOW - timedelta(days=10)).isoformat(),
            },
            {
                "productId": 505,
                "warehouseId": 3,
                "type": "OUTGOING",
                "quantity": 2,
                "createdAt": (_NOW - timedelta(days=20)).isoformat(),
            },
        ],
    }
    return movements_by_product.get(product_id, [])


def draft_purchase_order_mock(product_id: int, warehouse_id: int, quantity: int) -> dict:
    return {
        "supplierId": 5,
        "supplierName": "Nordic Components AB",
        "warehouseId": warehouse_id,
        "warehouseName": "London Central" if warehouse_id == 1 else "Manchester North",
        "lineItems": [
            {
                "productId": product_id,
                "productName": "USB-C Docking Station",
                "quantity": quantity,
                "unitCost": 34.50,
            },
        ],
        "estimatedTotal": round(quantity * 34.50, 2),
        "estimatedLeadTimeDays": 9,
        "isDraft": True,
    }
