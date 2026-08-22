"""Mocked supplier stats for the on-demand supplier analysis narration.

get_mock_supplier_stats() stands in for the backend's existing
getSupplierStats() / rankSuppliers() / getTransactionHistory(). Every
supplier here (Nordic Components AB, Global Peripherals Ltd, Rapid Source
Trading, Pixel Display Co) originally had its unit_cost/lead_time_days/
reliability_score/overall_score copied exactly from
tools/mocks/insights_mock_data.py's old compare_suppliers_mock()/
get_restock_recommendations_mock() fixtures (both deleted as dead code
during the pre-handoff cleanup pass, 2026-08-22, once compare_suppliers()
was wired to the real backend) - the values below are unchanged from
that original source, just no longer cross-referenced via a shared
import. recent_transaction_count/on_time_delivery_rate/product_categories
are fields that were never present in those old Insights mocks - added
here as plausible values consistent with each supplier's existing
profile.
"""

from __future__ import annotations

from tools.schemas.supplier_schema import SupplierStats

_MOCK_SUPPLIERS: dict[int, dict] = {
    # The reliable-but-pricier option.
    5: {
        "supplier_id": 5,
        "name": "Nordic Components AB",
        "unit_cost": 34.50,
        "lead_time_days": 9,
        "reliability_score": 0.97,
        "overall_score": 0.91,
        "recent_transaction_count": 42,
        "on_time_delivery_rate": 0.95,
        "product_categories": ["USB-C Docking Stations", "Computer Mice"],
    },
    # Cheapest, but slowest and least reliable of the three.
    7: {
        "supplier_id": 7,
        "name": "Global Peripherals Ltd",
        "unit_cost": 29.90,
        "lead_time_days": 21,
        "reliability_score": 0.74,
        "overall_score": 0.68,
        "recent_transaction_count": 18,
        "on_time_delivery_rate": 0.71,
        "product_categories": ["Mechanical Keyboards", "Peripherals"],
    },
    # Fastest lead time, solid reliability, mid-range cost.
    12: {
        "supplier_id": 12,
        "name": "Rapid Source Trading",
        "unit_cost": 31.10,
        "lead_time_days": 5,
        "reliability_score": 0.88,
        "overall_score": 0.87,
        "recent_transaction_count": 25,
        "on_time_delivery_rate": 0.85,
        "product_categories": ["General Hardware", "Fast-Turnaround Orders"],
    },
    # Pixel Display Co - a premium, higher-cost/longer-lead-time monitor
    # specialist.
    3: {
        "supplier_id": 3,
        "name": "Pixel Display Co",
        "unit_cost": 189.00,
        "lead_time_days": 21,
        "reliability_score": 0.90,
        "overall_score": 0.75,
        "recent_transaction_count": 15,
        "on_time_delivery_rate": 0.89,
        "product_categories": ["Monitors", "Displays"],
    },
}


class SupplierNotFoundError(LookupError):
    """Raised by get_mock_supplier_stats() when supplier_id isn't a known mock supplier.

    Deliberately a raised exception rather than a silent fallback to a
    default supplier record - "don't guess or fabricate an id, fail
    loudly instead" is the same principle every wired tool in this
    codebase now enforces for real against the actual backend.
    """


def get_mock_supplier_stats(supplier_id: int) -> SupplierStats:
    """Look up mock stats for one supplier, or raise if unknown.

    Args:
        supplier_id: The supplier's database ID.

    Returns:
        SupplierStats for that supplier.

    Raises:
        SupplierNotFoundError: If supplier_id doesn't match a known mock
            supplier - never falls back to a default/placeholder record.
    """
    record = _MOCK_SUPPLIERS.get(supplier_id)
    if record is None:
        raise SupplierNotFoundError(
            f"No supplier found for supplier_id={supplier_id!r}. "
            "Do not guess or fabricate a supplier_id - it must come from a "
            "real supplier record or from the user."
        )
    return SupplierStats.model_validate(record)
