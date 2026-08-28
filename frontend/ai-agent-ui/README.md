# ai-agent-ui

Standalone React component library for the AI module's frontend pieces. This
folder is **independent of `ai-agent/`** (the Python multi-agent backend) —
it has its own `package.json`, its own `node_modules`, and no dependency on
anything Python. A frontend teammate can pull just this folder and start
working without touching or even having the Python side installed.

Stack: Vite + React + TypeScript + Tailwind CSS v4 (via `@tailwindcss/vite`,
no separate `tailwind.config.js`/PostCSS setup needed). No UI component
library beyond Tailwind utility classes — nothing extra to install.

## Running the demo

```bash
npm install
npm run dev
```

Opens a preview page (`src/App.tsx`) rendering every component below against
realistic mock data (`src/mock-data.ts`). No backend, no `ai-agent/` Python
process, no network calls — everything is local mock state.

`npm run build` type-checks (`tsc -b`) and produces a production build.

## Integration model: props in, nothing else

Every component here is **presentational only** — no internal `fetch`,
no API calls, no knowledge of how data is actually retrieved. Wiring a
component into the real app means passing real data through its props, not
rewriting the component. Where a callback prop exists (`onSend`,
`onProposeAction`), the parent owns what actually happens when it fires —
these components only report the interaction.

Field names in `src/types.ts` are kept in **exact lockstep** with the AI
layer's real Pydantic schemas (snake_case, not camelCase, matching those
files directly) — a real payload from the AI layer can be passed into these
components with zero transformation.

## Components

### `ChatWidget`
`src/components/ChatWidget.tsx`

Chat interface for the Supervisor agent.

- `messages: ChatMessage[]` — `{ role: "user" | "supervisor"; content: string }[]`.
  Not a Python schema; mirrors what a caller accumulates from
  `ai-agent/agentcore_entrypoint.py`'s `{"prompt": string}` in /
  `{"result": string}` out HTTP contract (one request/response pair per
  turn).
- `onSend: (content: string) => void` — called with the trimmed input text
  when the user submits. The component holds no fetch logic itself; the
  parent is responsible for calling the real Supervisor and appending both
  the user's message and the `"supervisor"` reply to `messages`.

### `AlertCard`
`src/components/AlertCard.tsx`

Renders one alert.

- `alert: NarratedAlert` — matches
  `ai-agent/tools/schemas/control_tower_schema.py`'s `NarratedAlert`
  exactly: `id`, `category`, `severity`, `evidence`, `product_id`,
  `warehouse_id`, plus the generated `narrative` and `proposed_action`.
  Color-coded by `severity` (`low` / `medium` / `high` / `critical`).
- `onProposeAction?: (alert: NarratedAlert) => void` — fires when "Propose
  Action" is clicked. No real logic wired; the parent decides what a
  proposal actually does.

### `ControlTowerDashboard`
`src/components/ControlTowerDashboard.tsx`

Grid of `AlertCard`s with a severity filter.

- `alerts: NarratedAlert[]` — same shape as `AlertCard`, one per Control
  Tower alert (see `ai-agent/narration/control_tower.py`, the batch
  narration pass this data comes from).
- `onProposeAction?: (alert: NarratedAlert) => void` — forwarded to each
  `AlertCard`.
- The severity filter (all / critical / high / medium / low) is **local UI
  state only** — it filters the given `alerts` array in place, it does not
  refetch or re-narrate anything.

### `SupplierCard`
`src/components/SupplierCard.tsx`

Renders one supplier's stats and narration — the "explain this supplier"
button feature.

- `supplier: SupplierNarration` — matches
  `ai-agent/tools/schemas/supplier_schema.py`'s `SupplierNarration` exactly:
  `supplier_id`, `name`, `unit_cost`, `lead_time_days`,
  `reliability_score`, `overall_score`, `recent_transaction_count`,
  `on_time_delivery_rate`, `product_categories`, plus the generated
  `narrative` and `recommendation_context`.

### `ToolTraceView`
`src/components/ToolTraceView.tsx`

Collapsible "what the agent actually did" trace — a demo differentiator for
showing the real tool calls behind an answer, not just the final text.

- `trace: ToolTrace[]` — `{ toolName: string; status: "success" | "error"; summary: string }[]`.
  Not a Python schema; intended to be derived from a Strands `AgentResult`'s
  `.messages` `toolUse`/`toolResult` entries on the caller's side (see any
  test under `ai-agent/tests/` that inspects `agent.messages` for the
  parsing pattern this data comes from).
- `title?: string` — optional label, e.g. a short summary of the query this
  trace belongs to.

## Files

- `src/types.ts` — every prop shape above, as TypeScript types/interfaces.
- `src/mock-data.ts` — realistic mock data for every component, derived
  directly from `ai-agent/tools/mocks/control_tower_mock_data.py` and
  `ai-agent/tools/mocks/supplier_mock_data.py` (same ids, product names,
  warehouses, suppliers — e.g. Mechanical Keyboard, Nordic Components AB —
  so a demo using both the Python AI layer and this UI tells one consistent
  story). The `narrative` / `proposed_action` / `recommendation_context`
  text in the mocks is illustrative only, not copied from a real model run —
  swap in real narration output once the AI layer is wired up; the
  evidence/stat fields are the part that must stay byte-for-byte in sync
  with the Python mocks.
- `src/App.tsx` — demo page rendering all five components against the mock
  data.
