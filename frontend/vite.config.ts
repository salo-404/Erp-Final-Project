import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  // amazon-cognito-identity-js (frontend/src/auth/cognito.ts) references
  // Node's `global`/`Buffer` for its SRP crypto — undefined in the browser
  // and not polyfilled by Vite by default, which crashes the whole app on
  // load ("Uncaught ReferenceError: global is not defined").
  plugins: [react(), tailwindcss(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  server: {
    proxy: {
      // ai-agent/agentcore_entrypoint.py's local dev server only implements
      // POST /invocations — no OPTIONS handler, so it can't answer a
      // browser's CORS preflight (415/405, no CORS headers) and a direct
      // cross-origin fetch is blocked outright. Proxying keeps the browser
      // request same-origin; Vite forwards it server-side, where CORS
      // doesn't apply. Not a change to the AI service itself.
      "/agentcore": {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/agentcore/, ""),
      },
    },
  },
})
