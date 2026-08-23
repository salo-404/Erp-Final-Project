export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const COGNITO_USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "";
export const COGNITO_APP_CLIENT_ID = import.meta.env.VITE_COGNITO_APP_CLIENT_ID ?? "";

// ai-agent/agentcore_entrypoint.py run locally (python agentcore_entrypoint.py
// serves this on port 8080 by default per ai-agent/README.md).
export const AGENTCORE_URL = import.meta.env.VITE_AGENTCORE_URL ?? "http://localhost:8080";
