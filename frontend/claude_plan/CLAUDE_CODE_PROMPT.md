# Prompt to start a Claude Code session

Paste this at the start of your first Claude Code conversation in the repo.

---

You are working on **Nexora ERP**. The frontend is being rebuilt as a Next.js 15 App Router app in `apps/web/`. The backend is NestJS in `apps/api/`. AI agent runs on Python + FastAPI in `apps/ai/`.

Before writing any code:

1. Read `/handoff/README.md`, `/handoff/NEXORA_SPEC.md`, `/handoff/ENDPOINTS.md`, `/handoff/TYPES.md` in that order.
2. Open `NexoraERP.dc.html` at the repo root. It is a single-file mockup with the complete visual design and real state/event logic for every page. Treat it as the source of truth for anything the spec doesn't spell out.
3. Confirm the stack: **Next.js 15 App Router, TypeScript, TanStack Query, Zustand, Tailwind + shadcn/ui, ApexCharts, FullCalendar, NextAuth, Zod**. If any is missing from `package.json`, install it before starting.

Then work in this order:

1. Set up `apps/web` with the Nexora design tokens (colors from spec §2, Space Grotesk + Inter + JetBrains Mono fonts) and light/dark theme provider.
2. Generate typed API client from Nest's OpenAPI (`@nestjs/swagger`) into `packages/types`.
3. Build the app shell: Sidebar + Header + theme toggle + FAB placeholder (per spec §4).
4. Implement pages in the order in NEXORA_SPEC.md §8. For each page:
   - Copy the mockup's layout and inline styles into Tailwind classes (or a small tokens file).
   - Replace mockup's hardcoded data with TanStack Query hooks pointing to the endpoints in ENDPOINTS.md.
   - Wire event handlers to the mutations listed in that page's section of the spec.
   - Add loading skeletons, empty states, and error states — the mockup shows them all.
5. AI Agent last. Use EventSource + Nest gateway → Python service (see spec §4 "AI service split").
6. Google Calendar sync + email pipeline last.

Rules:
- Do NOT invent endpoints that aren't in `ENDPOINTS.md`. If you need a new one, add it to the spec first.
- Do NOT bypass Nest to hit the Python service directly.
- Keep every user-visible label matching the mockup verbatim.
- Every table with a status column must support inline status change via `<Select>` (see mockup's Purchase & Arrival and Customer Orders tables).
- Every modal in the spec is a `<Dialog>`.
- Persist UI state (sidebar collapsed, theme, active settings tab) in Zustand + localStorage.

When in doubt, re-read the section of the spec for the page you're building, then grep the mockup for the label on screen.
