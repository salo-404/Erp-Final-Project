"""Shared test support (not a test module itself - no test_ prefix).

live_model_configured() gates tests that need a real model call (agent
reasoning/error-handling behavior can't be verified against mocked tools
alone). It mirrors settings.build_model()'s provider branching so these
tests skip cleanly with no credentials under any provider, and run
automatically once one is actually usable - not just under OpenAI, since
local testing here isn't OpenAI-only (see config/settings.py).
"""

from __future__ import annotations

import urllib.error
import urllib.request

from config.settings import settings

_OLLAMA_PROBE_TIMEOUT_SECONDS = 1.0


def live_model_configured() -> bool:
    """Whether the active MODEL_PROVIDER can actually be called right now.

    - "openai": requires a real OPENAI_API_KEY (mirrors the existing
      test_*_live_openai_smoke skip condition).
    - "ollama": a cheap, fast reachability probe against OLLAMA_HOST - not
      just "was ollama selected", since MODEL_PROVIDER=ollama can be the
      persistent local .env setting even when no server happens to be
      running at test time (e.g. a fresh checkout, CI, or the server just
      isn't up), and that must skip rather than fail the whole suite.
    - "bedrock": no cheap, reliable way to verify AWS credentials without
      making a real call, so it's treated as "configured" once explicitly
      selected - if that's wrong (no credentials), the test will fail
      loudly rather than silently skip, which is preferable to masking a
      real setup problem for the provider that's meant for production.
    """
    if settings.model_provider == "openai":
        return bool(settings.openai_api_key)
    if settings.model_provider == "ollama":
        return _ollama_reachable()
    return settings.model_provider == "bedrock"


def _ollama_reachable() -> bool:
    url = f"{settings.ollama_host.rstrip('/')}/api/tags"
    try:
        with urllib.request.urlopen(url, timeout=_OLLAMA_PROBE_TIMEOUT_SECONDS):
            return True
    except (urllib.error.URLError, OSError, ValueError):
        return False
