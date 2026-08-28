export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

// Local-dev-only Cognito bypass (see AuthContext.tsx's finishLocalLogin and
// backend/src/common/guards/jwt-auth.guard.ts's LOCAL_AUTH_MODE branch) -
// never true in a real deployment. Off by default even locally; must be
// explicitly enabled in frontend/.env.
export const LOCAL_AUTH_MODE = import.meta.env.VITE_LOCAL_AUTH_MODE === "true";

export const COGNITO_USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "";
export const COGNITO_APP_CLIENT_ID = import.meta.env.VITE_COGNITO_APP_CLIENT_ID ?? "";

// ai-agent/agentcore_entrypoint.py run locally (python agentcore_entrypoint.py
// serves this on port 8080 by default per ai-agent/README.md). Relative
// path so the request goes through the Vite dev-server proxy
// (vite.config.ts) — the local AgentCore server can't answer a browser's
// CORS preflight, so a direct cross-origin URL here would be blocked.
export const AGENTCORE_URL = import.meta.env.VITE_AGENTCORE_URL ?? "/agentcore";
