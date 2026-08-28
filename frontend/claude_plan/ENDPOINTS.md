# Nexora API — endpoints the frontend consumes

Prefix: `/api/v1`. Auth: Bearer JWT (or NextAuth session cookie). Response envelope: `{ data, meta? }` on success, `{ error: { code, message } }` on error.

## Auth
- `POST /auth/login` — `{ email, password }` → `{ accessToken, refreshToken, user }`
- `POST /auth/refresh` — `{ refreshToken }` → `{ accessToken }`
- `POST /auth/logout`
- `GET /me`
- `PATCH /me` — profile fields
- `POST /me/password` — `{ current, next }`

## Warehouses
- `GET /warehouses`
- `GET /warehouses/:id`
- `GET /warehouses/:id/movements?type=all|inbound|outbound|adjustment&limit=`
- `GET /warehouses/:id/kpis`

## Inventory
- `GET /warehouses/:id/inventory?category=&search=&period=week|month|year`
- `GET /warehouses/:id/inventory/activity?period=`
- `GET /warehouses/:id/inventory/heatmap`
- `GET /warehouses/:id/inventory/categories`
- `POST /products`
- `PATCH /products/:sku`

## Products
- `GET /products/:sku` — includes movements + supplier ref
- `GET /products/:sku/movements`

## Analytics
- `GET /analytics/kpis?warehouse=&category=`
- `GET /analytics/inventory-value?range=7d|30d|90d`
- `GET /analytics/utilization`
- `GET /analytics/movement`
- `GET /analytics/top-selling`
- `GET /analytics/customer-categories`
- `GET /analytics/top-products-ordered?range=`

## Control Tower
- `GET /control-tower/issues?filter=&severity=`
- `POST /transfers` — `{ productSku, fromWarehouseId, toWarehouseId, qty }`

## Suppliers
- `GET /suppliers`
- `GET /suppliers/:id`
- `GET /suppliers/:id/performance?range=`
- `POST /suppliers`
- `PATCH /suppliers/:id`

## Purchases (Purchase & Arrival)
- `GET /purchases/arrivals`
- `POST /purchases`
- `PATCH /purchases/:id/status` — `{ status: 'arrived'|'transit'|'expected'|'delayed' }`

## Customer Orders
- `GET /customer-orders?filter=`
- `POST /customer-orders`
- `PATCH /customer-orders/:id/status` — `{ status }`

## Invoices
- `POST /invoices/upload` — multipart or presigned S3 flow → returns `{ invoiceId, s3Key }`
- `GET /invoices/:id`
- `GET /invoices/:id/extraction` — AI-extracted fields + ERP record for comparison
- `POST /invoices/:id/accept`
- `POST /invoices/:id/reject`

## Deliveries
- `GET /deliveries?month=YYYY-MM`
- `GET /deliveries/:id`
- `GET /deliveries/summary`

## Notifications
- `GET /notifications/prefs`
- `PATCH /notifications/prefs`
- `POST /notifications/test`

## Users (admin)
- `GET /users`
- `POST /users` — returns `{ user, tempPassword }`
- `PATCH /users/:id`
- `DELETE /users/:id`

## Settings
- `GET /settings/prefs`
- `PATCH /settings/prefs`

## AI Agent
- `POST /ai/sessions`
- `GET /ai/sessions/:id`
- `POST /ai/query` — `{ prompt, sessionId }` → SSE stream of typed events
- `GET /ai/query/stream?sessionId=` — SSE endpoint (if using GET-based SSE)

Event schema (each SSE `data:` line):
```json
{ "type": "text"|"table"|"chart"|"kpi"|"action"|"done", "payload": {...} }
```

## Realtime (WebSocket, Nest gateway)
- `wss://<host>/realtime`
- Server → client events: `inventory.updated`, `delivery.status_changed`, `order.status_changed`, `invoice.extracted`, `issue.raised`
