import re
from pathlib import Path

from sql.sql_guard import validate_sql


SEED_FILE = (
    Path(__file__).resolve().parents[2] / "backend" / "prisma" / "seed-query-examples.ts"
)


def _seeded_queries() -> list[str]:
    source = SEED_FILE.read_text(encoding="utf-8")
    return re.findall(r"\bsql:\s*`(.*?)`\s*,", source, flags=re.DOTALL)


def test_every_seeded_query_example_passes_the_complete_guard() -> None:
    queries = _seeded_queries()

    assert queries
    for query in queries:
        validate_sql(query.strip())


def test_net_stockmovement_examples_use_type_aware_signs() -> None:
    source = SEED_FILE.read_text(encoding="utf-8")
    net_queries = [
        query
        for query in _seeded_queries()
        if "net_stock_change" in query.lower() or "ledger_on_hand" in query.lower()
    ]

    assert len(net_queries) >= 2
    for query in net_queries:
        assert "INCOMING', 'TRANSFER_IN" in query
        assert "OUTGOING', 'TRANSFER_OUT" in query
        assert "THEN -sm.quantity" in query
        assert re.search(
            r"WHEN\s+sm\.type\s*=\s*'ADJUSTMENT'\s+THEN\s+sm\.quantity",
            query,
        )
    assert "StockMovement.quantity is already signed" not in source
