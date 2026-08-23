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
})
