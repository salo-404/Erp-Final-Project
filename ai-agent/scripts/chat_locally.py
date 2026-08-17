"""Minimal manual REPL for chatting with the Supervisor agent locally.

NOT an automated test - this is for manually sanity-checking a real,
multi-turn conversation against whichever MODEL_PROVIDER is set in .env
(defaults to "openai", so this works with just an OPENAI_API_KEY and no AWS
access - see README.md "Switching providers").

Usage (from the ai-agent/ directory):

    python -m scripts.chat_locally
    # or
    python scripts/chat_locally.py

Type "exit" (or Ctrl+C / Ctrl+D) to quit.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `agents`/`config`/etc. importable whether this is run as
# `python -m scripts.chat_locally` (CWD already on sys.path) or as a bare
# `python scripts/chat_locally.py` (only scripts/ itself would be on
# sys.path otherwise).
_AI_AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(_AI_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AI_AGENT_ROOT))

from agents.supervisor.agent import build_supervisor_agent  # noqa: E402
from config.settings import settings  # noqa: E402


def main() -> None:
    print(f"Building Supervisor agent (MODEL_PROVIDER={settings.model_provider!r})...")
    agent = build_supervisor_agent()
    print("Ready. Type a message and press Enter. Type 'exit' to quit.\n")

    while True:
        try:
            user_input = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not user_input:
            continue
        if user_input.lower() == "exit":
            break

        response = agent(user_input)
        print(f"supervisor> {response}\n")


if __name__ == "__main__":
    main()
