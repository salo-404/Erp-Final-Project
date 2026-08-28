"""Local dev launcher for the same AgentCore app as agentcore_entrypoint.py,
with auto-restart on file save.

NOT used for deployment - agentcore_entrypoint.py's own `python
agentcore_entrypoint.py` (calling BedrockAgentCoreApp.run(), which is what
Docker/AgentCore Runtime actually invokes) is completely untouched by this
file. This script exists purely so local edits under ai-agent/ take effect
automatically, without killing and restarting the process by hand every
time - the same convenience the frontend's Vite dev server already gives
you for free.

It works by calling uvicorn directly with reload=True instead of going
through BedrockAgentCoreApp.run() (which passes itself to uvicorn as a
live object, and uvicorn's reload mode requires an import string instead,
since it re-imports the module fresh in a new process on every change).
`agentcore_entrypoint.py`'s module-level code (the `app = BedrockAgentCoreApp()`
object and the `@app.entrypoint` function) runs exactly the same way either
way - only how the process gets (re)started differs.

Usage (from the ai-agent/ directory):

    python -m scripts.dev_server

Same port (8080) and host (127.0.0.1) as agentcore_entrypoint.py's own
default - the frontend's Vite proxy (see frontend/vite.config.ts) needs no
changes to use this instead.
"""

from __future__ import annotations

import uvicorn


def main() -> None:
    uvicorn.run(
        "agentcore_entrypoint:app",
        host="127.0.0.1",
        port=8080,
        reload=True,
        reload_dirs=["."],
        reload_excludes=[".venv/*", "**/__pycache__/*", "*.pyc"],
    )


if __name__ == "__main__":
    main()
