# Nexora ERP — Frontend Spec (Claude Code handoff)

This is the complete spec Claude Code needs to rebuild the Nexora frontend against a NestJS API + Python AI service. The visual reference is `NexoraERP.dc.html` in the same project (single-file React-style mockup — all inline styles, real state, real event handlers). Read it alongside this spec.

---

## 1. Recommended stack

- **Next.js 15 (App Router) + TypeScript**
- **TanStack Query** (all server state)
- **Zustand** (UI state: sidebar collapsed, theme, active modal)
- **Tailwind CSS + shadcn/ui** (Select, Dialog, Tabs, Toast, DropdownMenu, Sheet)
- **ApexCharts** (already the mockup's chart lib) — swap in Recharts if preferred
- **FullCalendar** for Delivery Center (swap-out point for Google Calendar API later)
- **Zod + openapi-typescript** — consume Nest's `@nestjs/swagger` schema for typed clients
- **EventSource / WebSocket** — AI Agent streaming (Nest gateway proxies Python service)
- **NextAuth.js** for login/session

Repo layout:
```
apps/
  api/        NestJS
  ai/         Python (FastAPI + Claude)
  web/        Next.js
packages/
  types/      shared Zod + generated OpenAPI types
  ui/         shadcn components
```

---

## 2. Design system (extracted from the mockup)

| Token           | Light                          | Dark                             |
|-----------------|--------------------------------|----------------------------------|
| bg              | `#FAFAFA`                      | `#0E0E12`                        |
| surface         | `#FFFFFF`                      | `#16171D`                        |
| surface2        | `#F6F3FB`                      | `#1F1F27`                        |
| border          | `rgba(0,0,0,0.08)`             | `rgba(255,255,255,0.08)`         |
| text            | `#1A1B26`                      | `#E8EAF0`                        |
| textSecondary   | `#4A4E5A`                      | `#A8B0C0`                        |
| textMuted       | `#8A8F9C`                      | `#6B7280`                        |
| accent          | `#6D3FD9` (indigo)             | `#F4C430` (gold)                 |
| danger          | `#EF4444`                      | `#EF4444`                        |
| success         | `#22C55E`                      | `#22C55E`                        |
| warning         | `#F4C430`                      | `#F4C430`                        |

Fonts: **Space Grotesk** (headings 600/700), **Inter** (body 400/500/600), **JetBrains Mono** (numbers/SKUs).

Sidebar in light mode uses a dark palette (`bg #1A1B26 / text #E8EAF0`) for contrast — see the mockup's `sidebarC` object.

---

## 3. Pages & functionality

### 3.1 Login (`/login`)
- Two-column: form left (centered), warehouse hero image right.
- Fields: email, password. Buttons: **Sign in**, **Sign up** link.
- Endpoint: `POST /auth/login` → `{ accessToken, refreshToken, user }`.
- SSO placeholder text; wire to NextAuth later.

### 3.2 Warehouses (`/warehouses`)
- Warehouse cards grid + selector.
- KPI strip: totalUnits, capacityPct, activeSkus, monthlyThroughput.
- Selected warehouse detail: throughput chart (6-month bar), Stock Movement Ledger (filter tabs: all/inbound/outbound/adjustment).
- Endpoints:
  - `GET /warehouses` → list
  - `GET /warehouses/:id` → detail incl. `categoriesPct`, `kpis`
  - `GET /warehouses/:id/movements?type=all|inbound|outbound|adjustment&limit=50`

### 3.3 Inventory (`/inventory`)
- Warehouse selector (native dropdown, same as Warehouses page).
- Search + Category filter dropdown.
- 3 cards: **Stock Activity** (Reserved / In-The-Way / Arrived, 7-day bars per card), **Inventory by Category** (Week/Month/Year period tabs), **Top Products** (7-day heatmap).
- Products table: SKU, Product, Category, Available, Status, Actions (view/edit). Reserved/InWay/Arrived columns removed per user request.
- Add Product button (opens modal — not implemented yet, wire to `POST /products`).
- Endpoints:
  - `GET /warehouses/:id/inventory?category=&search=&period=week|month|year`
  - `GET /warehouses/:id/inventory/activity?period=` → stock activity 7-day series
  - `GET /warehouses/:id/inventory/heatmap` → top products 7-day intensity
  - `POST /products`, `PATCH /products/:sku`

### 3.4 Product Detail (`/products/:sku`)
- Header with SKU, name, status pill, price.
- Stock bar (reorder level marker), supplier card, movement history list.
- Endpoint: `GET /products/:sku` → full detail incl. movements, supplier ref.

### 3.5 Analytics (`/analytics`) — two tabs

**Overview tab**
- KPIs: 4 cards (Total Value, Active SKUs, Monthly Throughput, Warehouse Utilization).
- Charts:
  - Total Inventory Value (ApexCharts area, current vs previous period)
  - Warehouse Utilization (ApexCharts stacked bar by category, purple/gold/black/white palette)
  - Stock Movement (multi-line: incoming/outgoing/transfers/adjustments)
  - Top Selling Products (list — no left-side boxes per user request)
- Filters: warehouse + category dropdowns
- Endpoints:
  - `GET /analytics/kpis?warehouse=&category=`
  - `GET /analytics/inventory-value?range=7d|30d|90d`
  - `GET /analytics/utilization`
  - `GET /analytics/movement`
  - `GET /analytics/top-selling`

**Control Tower tab**
- Issue queue grouped: Attention, Insights, Documents.
- Filters: severity, type (all/stockout/restock/transfer/deadstock/anomaly/document).
- Row actions:
  - Stockout → view product
  - Restock → create PO / suggest transfer
  - Transfer → opens **Transfer Modal** (Cancel / Confirm Transfer)
  - Deadstock → 4 detail tables (kept per user request), no combined table
  - Document → opens **AI Invoice Review Modal** (see 3.9)
- Endpoints:
  - `GET /control-tower/issues?filter=&severity=`
  - `POST /transfers` `{ productSku, fromWarehouseId, toWarehouseId, qty }`

### 3.6 Suppliers & Orders (`/suppliers`) — two tabs

**Suppliers tab**
- **Top Suppliers** card: ranked medal cards (GOLD/SILVER/BRONZE/4TH) with circular ring gauge scores.
- **Supplier Performance** card: dropdown to pick a supplier, 4 stat mini-cards (On-time Delivery, Cancellation Rate, Average Price, Purchase Frequency) with sparkline trends.
- **Purchase Invoice Process** card (above Purchase & Arrival, per user request): 4-step flow (Upload → AI Extract → Review → Add to Inventory). **Upload Invoice** button under it → opens invoice-upload modal (drag & drop → S3 → AI extract).
- **Purchase & Arrival** table: Product / Supplier / Qty / Arrival Info / Status. Non-arrived statuses render an inline `<select>` styled as a badge to change status.
- Buttons: Add Supplier (accent), Upload Invoice (moved above table).

Endpoints:
- `GET /suppliers` → list with rating, POs count
- `GET /suppliers/:id/performance?range=30d` → on-time%, cancellation%, avgPrice, frequency, sparkline
- `GET /purchases/arrivals` → purchase & arrival rows
- `PATCH /purchases/:id/status` `{ status: 'arrived'|'transit'|'expected'|'delayed' }`
- `POST /suppliers`
- `POST /invoices/upload` → returns `{ invoiceId, s3Key }`; AI extraction runs async, status via SSE or polling

**Customer Orders tab**
- **Top Customer Categories** card: single 100%-stacked bar + 2×2 tiles with % + delta.
- **Order Status** donut (SVG arc paths — total in center + legend).
- **Top Products Ordered** vertical bar chart.
- **Customer Orders** table: Order ID / Customer / Warehouse / Items / Status / Delivery. Non-final statuses render inline `<select>` to update.
- Endpoints:
  - `GET /customer-orders?filter=`
  - `PATCH /customer-orders/:id/status`
  - `GET /analytics/customer-categories`
  - `GET /analytics/top-products-ordered?range=30d`

### 3.7 Delivery Center (`/delivery`)
- Month navigator (‹ Feb 2026 ›), **Today** button, filter pills (All/Today/Upcoming/Overdue), **Sync with Google Calendar** button.
- Status summary strip: 4 counters.
- Custom **calendar grid** (7×6): cells show up to 2 delivery chips (colored by status), `+N` overflow, selected-day highlight, today circle.
- **Selected day panel**: delivery cards → click routes to Suppliers & Orders for that PO.
- **Email Notifications** card: Gmail connection pill, 3 toggle cards (Today / Upcoming / Overdue) with descriptions, Send Test Email button.
- Endpoints:
  - `GET /deliveries?month=YYYY-MM`
  - `GET /deliveries/summary`
  - `GET /notifications/prefs`
  - `PATCH /notifications/prefs`
  - `POST /notifications/test`
  - Later: `GET /calendar/google/sync`, `POST /calendar/google/connect`

### 3.8 AI Agent (`/ai-agent`) + Floating FAB
- FAB: fixed bottom-right, uses `assets/nexora-ai-agent-logo.png`. Hover: scale + rotate + orbit ring + pulse + label slide-in. Hidden on `/login` and on the AI page itself.
- Left rail: agent identity card, quick-ask category tiles, Recent asks list.
- Main canvas: streamed conversation with user bubble + agent responses. Response types the UI must handle:
  - **text** (paragraph bubble)
  - **table** (schema: `{ columns: [{key,label,align}], rows: [{...}], meta: string }`)
  - **kpi** (single metric card)
  - **chart** (bars / donut / line — reuse ApexCharts)
  - **actions** (chips linking to ERP pages)
- Input bar with plus (attach), pulse dot ("Reading ERP data"), send button.
- Endpoints:
  - `POST /ai/query` `{ prompt, sessionId }` → SSE stream of `{ type: 'text'|'table'|'chart'|'kpi'|'action', payload }` events
  - `GET /ai/sessions/:id`
  - `POST /ai/sessions`
- Backend: Nest proxies to Python FastAPI (`/ai/query` internal) which owns the Claude call + ERP tool-use.

### 3.9 AI Invoice Review Modal (from Control Tower → Review)
- Header: AI logo + doc number + supplier + date + close.
- Confidence badge card (e.g. 96%).
- **Header fields comparison** table: Field / AI extracted / ERP record / Match.
- **Line items comparison** table: SKU + Product / AI qty / ERP qty / AI total / ERP total / Match icon.
- Footer: Reject / **Accept & Sync**.
- Endpoints:
  - `GET /invoices/:id/extraction` → both AI + ERP objects
  - `POST /invoices/:id/accept`
  - `POST /invoices/:id/reject`

### 3.10 Settings (`/settings`) — sidebar tabs
- **Account**: profile fields + password/security card, Log out button.
- **Users**: table (User / Role / Warehouse / Status / Last active / Actions) + **+ Create User** wizard modal:
  - Step 1: Details (name, email)
  - Step 2: Role (worker/manager/admin) + warehouse scope
  - Step 3: Generated temp password (copy) + summary → **Finish & Send Credentials**
- **Appearance**: theme cards + density toggle.
- **Notifications**: delivery email toggles + in-app alert toggles.
- **AI**: 4 preference toggles (visual responses, auto-execute low-risk, weekly digest, voice).
- **General**: default warehouse, low-stock threshold, currency, timezone, date format, landing page.
- Endpoints:
  - `GET /users`, `POST /users` (returns tempPassword), `PATCH /users/:id`, `DELETE /users/:id`
  - `PATCH /me` (profile), `POST /me/password`
  - `GET /settings/prefs`, `PATCH /settings/prefs`

---

## 4. Global concerns

### Layout
- Sidebar (collapsible via top-right chevron): Overview → Operations → Procurement → Intelligence → System.
- Header per page: title + subtitle + search + notifications bell + theme toggle + user avatar.
- All pages scroll independently; the sidebar and header are fixed.

### Auth
- JWT access + refresh, HttpOnly cookies.
- Route guard: everything except `/login` requires session.

### API conventions
- Prefix: `/api/v1`
- All responses: `{ data, meta? }` on success; `{ error: { code, message } }` on failure.
- Pagination: `?limit=50&cursor=...` → `meta: { nextCursor }`.
- Status enums live in `packages/types` and MUST match backend Zod schemas exactly.

### Realtime
- SSE for AI streaming: `GET /ai/query/stream?token=...`
- WebSocket for delivery/inventory live updates: `wss://.../realtime` — Nest gateway broadcasts `inventory.updated`, `delivery.status_changed`, etc.

### AI service split
- Frontend NEVER talks to Python directly.
- Nest exposes `/ai/query` → forwards to Python `POST http://ai:8000/query` with the user's session, current ERP context (warehouses, active POs, etc.), and RBAC-scoped tool list.
- Python answers via SSE; Nest re-streams to the browser.

---

## 5. State shapes (from the mockup — port to Zustand + TanStack Query)

Global UI (Zustand):
```ts
{
  sidebarOpen: boolean;
  theme: 'light' | 'dark';
  activeModal: null | { type: 'transfer'|'document'|'invoice'|'user-wizard', payload: any };
}
```

Per-page URL state (Next.js searchParams):
- Warehouses: `?w=<warehouseId>`
- Inventory: `?w=&q=&category=&period=`
- Suppliers: `?tab=suppliers|customer-orders&supplier=<id>`
- Delivery: `?month=YYYY-MM&date=YYYY-MM-DD&filter=all|today|upcoming|overdue`
- Settings: `?tab=account|users|appearance|notifications|ai|general`

Server state (TanStack Query keys):
- `['warehouses']`, `['warehouse', id]`, `['warehouse', id, 'movements', filter]`
- `['inventory', warehouseId, filters]`, `['inventory-activity', warehouseId, period]`
- `['suppliers']`, `['supplier-performance', supplierId, range]`
- `['purchases']`, `['customer-orders', filter]`
- `['deliveries', month]`, `['delivery-prefs']`
- `['issues', filter, severity]`
- `['ai-session', sessionId]`
- `['users']`, `['me']`, `['settings']`

---

## 6. Component mapping (mockup → shadcn/ui)

| Mockup pattern                                    | shadcn component            |
|---------------------------------------------------|-----------------------------|
| Status pill                                       | `<Badge variant="...">`     |
| Editable status dropdown (Purchase / CO tables)   | `<Select>` styled as badge  |
| Confirm modal (transfer / doc / invoice / user)   | `<Dialog>`                  |
| User-wizard steps                                 | `<Dialog>` + custom stepper |
| Toggle (notifications, AI prefs)                  | `<Switch>`                  |
| Sidebar collapse                                  | `<Sheet>` on mobile         |
| Filter pill row                                   | `<ToggleGroup type="single">` |
| Command palette (future)                          | `<Command>` (cmdk)          |
| Toast on save                                     | `sonner`                    |

---

## 7. Charts

- Total Inventory Value / Warehouse Utilization / Stock Movement → **ApexCharts** (as in mockup).
- Order Status donut → **SVG arc paths** (in `packages/ui/donut.tsx`).
- Top Products Ordered → simple SVG bars.
- Sparklines in Stock Activity + Supplier Performance → hand-rolled SVG polyline.

---

## 8. Migration order (suggested)

1. Scaffold `apps/web` with the design tokens + typography + light/dark ThemeProvider.
2. Login page + auth.
3. App shell (Sidebar + Header + theme toggle + FAB placeholder).
4. Warehouses page (biggest data surface) — proves the API + state layer.
5. Inventory + Product Detail.
6. Analytics + Control Tower.
7. Suppliers & Orders (Suppliers tab first, then Customer Orders).
8. Delivery Center.
9. Settings.
10. AI Agent + streaming.
11. Google Calendar sync + email pipeline last.

---

## 9. What's already in the mockup source

Every page above exists in `NexoraERP.dc.html` with:
- Real inline styles you can copy verbatim into Tailwind or a token file.
- Real event handlers (`onClick`, `onChange`) — the names map to the API mutations you'll wire.
- Real derived data functions in `renderVals()` — read them to know exactly what shape each endpoint should return.

When in doubt, `grep` the mockup for the label the user sees on screen; the surrounding markup + logic is the source of truth.
