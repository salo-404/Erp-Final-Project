"""Manual sanity-check script for the Control Tower narration layer.

NOT an automated test - run it directly to see narrate_all_alerts() work
against the mock alert set and eyeball the output. Same spirit as
scripts/chat_locally.py for the Supervisor's live chat path, but this is
the batch narration path instead - Control Tower is not a chat entry point
and this script doesn't behave like one (no REPL, no back-and-forth): it
fetches the mock alert set once, narrates all of them, and prints the
results.

Usage (from the ai-agent/ directory):

    python -m scripts.run_control_tower_narration
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

# Make `narration`/`tools`/`config` importable whether this is run as
# `python -m scripts.run_control_tower_narration` (CWD already on sys.path)
# or as a bare `python scripts/run_control_tower_narration.py`.
_AI_AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(_AI_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AI_AGENT_ROOT))

from config.settings import settings  # noqa: E402
from narration.control_tower import narrate_all_alerts  # noqa: E402
from tools.mocks.control_tower_mock_data import get_mock_control_tower_alerts  # noqa: E402


def main() -> None:
    alerts = get_mock_control_tower_alerts()
    print(f"Narrating {len(alerts)} mock alerts (MODEL_PROVIDER={settings.model_provider!r})...\n")

    start = time.monotonic()
    narrated = narrate_all_alerts(alerts)
    elapsed = time.monotonic() - start

    for item in narrated:
        print(f"[{item.severity.value.upper()}] {item.category.value} (alert {item.id})")
        print(f"  Narrative:       {item.narrative}")
        print(f"  Proposed action: {item.proposed_action}")
        print()

    print(f"Done - {len(narrated)} alerts narrated in {elapsed:.1f}s.")


if __name__ == "__main__":
    main()
