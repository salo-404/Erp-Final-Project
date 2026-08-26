export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

export const COGNITO_USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "";
export const COGNITO_APP_CLIENT_ID = import.meta.env.VITE_COGNITO_APP_CLIENT_ID ?? "";

// ai-agent/agentcore_entrypoint.py run locally (python agentcore_entrypoint.py
// serves this on port 8080 by default per ai-agent/README.md). Relative
// path so the request goes through the Vite dev-server proxy
// (vite.config.ts) — the local AgentCore server can't answer a browser's
// CORS preflight, so a direct cross-origin URL here would be blocked.
export const AGENTCORE_URL = import.meta.env.VITE_AGENTCORE_URL ?? "/agentcore";
