# Nexora — Claude Code handoff bundle

Drop this folder into the root of your NestJS/Python monorepo. Claude Code should read the files in this order:

1. `README.md` (this file)
2. `NEXORA_SPEC.md` — full functional + API spec
3. `ENDPOINTS.md` — flat list of every endpoint the frontend expects
4. `TYPES.md` — shared type shapes (port to Zod)
5. `CLAUDE_CODE_PROMPT.md` — the prompt to paste when starting a Claude Code session
6. `NexoraERP.dc.html` (project root, one level up) — the visual + behavioral source of truth

Everything the frontend needs to look and behave correctly is either in the spec files here or in `NexoraERP.dc.html`. If a detail is missing, `grep` the mockup for the on-screen label and read the surrounding markup + `renderVals()` logic.

Stack (see NEXORA_SPEC.md §1 for the full list):
- Next.js 15 App Router + TypeScript
- TanStack Query + Zustand
- Tailwind + shadcn/ui
- ApexCharts
- FullCalendar (Delivery)
- NextAuth
