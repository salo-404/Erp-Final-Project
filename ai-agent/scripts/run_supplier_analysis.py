"""CLI script for the on-demand supplier analysis narration ("explain this supplier").

NOT an automated test - run it directly against a supplier_id to see
narrate_supplier() work and eyeball the output. Unlike
scripts/run_control_tower_narration.py's batch loop over every alert, this
is on-demand and CLI-driven: one supplier per run, picked by you.

Usage (from the ai-agent/ directory):

    python scripts/run_supplier_analysis.py <supplier_id>

Example (known mock suppliers - see tools/mocks/supplier_mock_data.py):

    python scripts/run_supplier_analysis.py 5
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `narration`/`tools`/`config` importable whether this is run as
# `python scripts/run_supplier_analysis.py <id>` (the documented form) or
# as `python -m scripts.run_supplier_analysis <id>`.
_AI_AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(_AI_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AI_AGENT_ROOT))

from narration.supplier_analysis import narrate_supplier  # noqa: E402
from tools.mocks.supplier_mock_data import SupplierNotFoundError  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python scripts/run_supplier_analysis.py <supplier_id>", file=sys.stderr)
        sys.exit(2)

    supplier_id = sys.argv[1]

    try:
        result = narrate_supplier(supplier_id)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(2)
    except SupplierNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Supplier: {result.name} (ID {result.supplier_id})")
    print(f"  Unit cost:             {result.unit_cost}")
    print(f"  Lead time:             {result.lead_time_days} days")
    print(f"  Reliability score:     {result.reliability_score}")
    print(f"  Overall score:         {result.overall_score}")
    print(f"  Recent transactions:   {result.recent_transaction_count}")
    print(f"  On-time delivery rate: {result.on_time_delivery_rate}")
    print(f"  Product categories:    {', '.join(result.product_categories)}")
    print()
    print(f"Narrative:\n  {result.narrative}")
    print()
    print(f"Recommendation context:\n  {result.recommendation_context}")


if __name__ == "__main__":
    main()
