"""Manual sanity-check script for the Control Tower narration layer.

NOT an automated test - run it directly to fetch and narrate the real
NestJS alert set and eyeball the output. Same spirit as
scripts/chat_locally.py for the Supervisor's live chat path, but this is
the batch narration path instead - Control Tower is not a chat entry point
and this script doesn't behave like one (no REPL, no back-and-forth): it
fetches the backend alert set once, narrates all of them, and prints the
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
from narration.control_tower import fetch_and_narrate_control_tower_alerts  # noqa: E402


def main() -> None:
    start = time.monotonic()
    narrated = fetch_and_narrate_control_tower_alerts()
    elapsed = time.monotonic() - start

    print(f"Narrated {len(narrated)} backend alerts (MODEL_PROVIDER={settings.model_provider!r}).\n")

    for item in narrated:
        print(f"[{item.severity.value}] {item.category.value}")
        print(f"  Narrative:       {item.narrative}")
        print(f"  Proposed action: {item.proposed_action}")
        print()

    print(f"Done - {len(narrated)} alerts narrated in {elapsed:.1f}s.")


if __name__ == "__main__":
    main()
