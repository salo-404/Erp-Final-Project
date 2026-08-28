# erp-frontend-mockup

**This is a throwaway/reference UI mockup — not meant to be merged wholesale
into the team's real frontend repo.** Its purpose is to pin down
layout/flow/UX decisions for the core ERP flow (warehouses → inventory →
create order → order tracking) so the eventual merge conversation with the
frontend teammate has something concrete to point at, and to mark exactly
where backend and AI integration points belong.

No real backend, no real AI calls. Everything runs against local in-memory
React state (`src/data/AppDataContext.tsx`), seeded from
`src/data/mockData.ts`. Refreshing the page resets all data.

Stack: Vite + React + TypeScript + Tailwind CSS v4 — same as
[`../frontend/ai-agent-ui/`](../frontend/ai-agent-ui/), but this is a fully
separate project (own `package.json`, own `node_modules`). **Not** a
dependency of, and does not import from, `ai-agent-ui/` — see "Relationship
to ai-agent-ui/" below.

## Running it

```bash
npm install
npm run dev
```

## What's here

- Left sidebar navigation (Warehouses, Orders, Control Tower, Suppliers,
  Settings) — plain local state switching, no router, no page reloads.
- **Warehouses**: list view with Create/Edit/Delete (modal forms). Clicking
  a warehouse opens its inventory view.
- **Warehouse detail**: products grouped into collapsible category
  sections, each with a "Create Order" button.
- **Create Order**: modal form (product pre-filled, amount, supplier
  dropdown) → mock "Order sent to [Supplier]" success state.
- **Orders**: global table of all orders across all warehouses, with a
  status column covering the full status range (Pending, Sent to Supplier,
  Invoice Received, Discrepancy Flagged, Fulfilled).
- **Control Tower**, **Suppliers**: minimal placeholders — see the
  MERGE-AI comments in `src/pages/ControlTowerPage.tsx` and
  `src/pages/SuppliersPage.tsx`.
- **Settings**: minimal placeholder.
- Floating chat button (bottom-right) → slide-in panel
  (`src/components/ChatPanel.tsx`), visually modeled after
  `ai-agent-ui`'s `ChatWidget` but a separate, self-contained component.

## Finding the integration points

Every point where this mockup fakes something a real backend or the AI
module will eventually do is marked with a consistent comment, so they're
`grep`-able:

```
// MERGE-BACKEND: <what real backend function/endpoint this replaces>
// MERGE-AI: <what AI module function/agent this connects to>
```

```bash
grep -rn "MERGE-BACKEND\|MERGE-AI" src/
```

Current integration points:

| Where | Marker | Replaces with |
|---|---|---|
| `src/data/AppDataContext.tsx` (`createWarehouse`/`updateWarehouse`/`deleteWarehouse`) | `MERGE-BACKEND` | Backend's Warehouses CRUD endpoints — see `Backend_vs_AI_Work_Split.md` "Products, Warehouses, Suppliers" |
| `src/data/AppDataContext.tsx` (`createOrder`), `src/components/CreateOrderModal.tsx` | `MERGE-BACKEND` | Backend's order/transaction creation endpoint + its email service — see `Backend_vs_AI_Work_Split.md` "Email / Calendar services" |
| `src/data/AppDataContext.tsx` (`createOrder`'s initial status), `src/pages/OrdersPage.tsx` | `MERGE-AI` | `ai-agent/agents/document_agent`'s `extract_document(doc_type="invoice")` and `detect_discrepancy()` — should drive the "Invoice Received" / "Discrepancy Flagged" transitions once a real supplier invoice reply triggers document ingestion |
| `src/pages/ControlTowerPage.tsx` | `MERGE-AI` | Real `AlertCard`/`ControlTowerDashboard` from `ai-agent-ui/src/components/`, fed by `ai-agent/narration/control_tower.py` |
| `src/pages/SuppliersPage.tsx` | `MERGE-AI` | Real `SupplierCard` from `ai-agent-ui/src/components/`, fed by `ai-agent/narration/supplier_analysis.py` |
| `src/components/ChatPanel.tsx` | `MERGE-AI` | The real Supervisor, via `ai-agent/agentcore_entrypoint.py`'s `POST /invocations`; consider swapping this component for `ai-agent-ui`'s real `ChatWidget` at merge time |

## Relationship to ai-agent-ui/

[`../frontend/ai-agent-ui/`](../frontend/ai-agent-ui/) is the real,
production-intended component library for AI-facing pieces (`AlertCard`,
`ControlTowerDashboard`, `SupplierCard`, `ChatWidget`, `ToolTraceView`),
typed against the actual Python schemas in `ai-agent/tools/schemas/`. This
project deliberately does **not** import from it — the Control
Tower/Suppliers/chat placeholders here are self-contained mockups, clearly
marked `MERGE-AI`, meant to be swapped for the real components later. Kept
separate so neither project has to worry about breaking the other while
both evolve independently.
