# Mini ERP — Salman Backend Plan

## Scope Note

This document covers **only Salman's slice of the NestJS backend**, per the finalized split in `Backend-Team-Split.md` (§2), updated with the backend work adopted from Ribal's AI work-split note (`Work-Split-Alignment.md`).

- Joseph's slice (Products, Warehouses CRUD, Supplier CRUD, Warehouse Inventory reads, Analytics, Integrations) stays in `Backend-Team-Split.md` § Joseph — unchanged.
- The AI/AgentCore side (agents, tools, folder structure) lives in `AI-Agent-Plan.md` — not duplicated here.
- The backend/AI boundary and tool contracts live in `AI-Backend-Scope.md`.

Core principle, unchanged everywhere else in this doc set:

> NestJS owns the database, business logic, validation, permissions, and all writes. AgentCore consumes controlled backend data — it never calculates anything itself.

Two folders below (`suppliers/`, `warehouse-inventory/`) are **shared** with Joseph. To avoid both of you editing the same service file, each shared folder splits into a CRUD/read service (Joseph) and an intelligence/routing service (Salman) — see the per-module notes.

---

## Folder & File Structure

```
src/
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── strategies/
│   │   └── jwt.strategy.ts
│   └── dto/
│       └── login.dto.ts
│
├── users/
│   ├── users.module.ts
│   ├── users.controller.ts
│   ├── users.service.ts
│   └── dto/
│       ├── create-user.dto.ts
│       └── update-user.dto.ts
│
├── common/
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   └── roles.guard.ts
│   ├── decorators/
│   │   ├── roles.decorator.ts
│   │   └── current-user.decorator.ts
│   ├── filters/
│   └── pipes/
│
├── suppliers/                          (shared with Joseph)
│   ├── suppliers.module.ts
│   ├── suppliers.controller.ts
│   ├── suppliers.service.ts             ← Joseph: CRUD + getTransactionHistory()
│   ├── supplier-intelligence.service.ts ← Salman: stats/ranking functions below
│   └── dto/
│       ├── create-supplier.dto.ts
│       └── update-supplier.dto.ts
│
├── warehouse-inventory/                (shared with Joseph)
│   ├── warehouse-inventory.module.ts
│   ├── warehouse-inventory.controller.ts
│   ├── warehouse-inventory.service.ts   ← Joseph: reads + capacity + threshold
│   ├── warehouse-routing.service.ts     ← Salman: findBestWarehouseForOrder()
│   └── dto/
│       └── set-reorder-threshold.dto.ts
│
├── stock-movements/
│   ├── stock-movements.module.ts
│   ├── stock-movements.controller.ts
│   └── stock-movements.service.ts
│
├── reservations/
│   ├── reservations.module.ts
│   └── reservations.service.ts
│
├── inventory-transactions/
│   ├── inventory-transactions.module.ts
│   ├── inventory-transactions.controller.ts
│   ├── inventory-transactions.service.ts
│   └── dto/
│       ├── create-incoming.dto.ts
│       ├── create-outgoing.dto.ts
│       ├── create-transfer.dto.ts
│       └── update-transaction.dto.ts
│
├── document-review/
│   ├── document-review.module.ts
│   ├── document-review.controller.ts
│   ├── document-review.service.ts
│   └── dto/
│       ├── upload-document.dto.ts
│       └── review-document.dto.ts
│
├── stock-insights/
│   ├── stock-insights.module.ts
│   ├── stock-insights.controller.ts
│   ├── stock-insights.service.ts
│   └── control-tower.service.ts         ← new, see §8 below
│
└── prisma/
    └── prisma.service.ts                (shared with Joseph)
```

---

## 1. Authentication & Security

Folders: `src/auth/`, `src/users/`, `src/common/guards/`

```
AuthService
├── validateUser(email, password)
└── login(dto)

UsersService
├── create(dto)
├── findAll()
├── findOne(id)
├── update(id, dto)
└── remove(id)
```

Also owns: `JwtStrategy`, `JwtAuthGuard`, `RolesGuard`, role decorators, password hashing, ADMIN/EMPLOYEE permission enforcement at the endpoint level.

## 2. Supplier Intelligence

Folder: `src/suppliers/` (service file split from Joseph's CRUD service — see structure above)

```
SupplierIntelligenceService
├── getSupplierStats(supplierId)
├── compareSuppliers(productId)
├── rankSuppliers(...)
└── getBestSupplier(...)
```

Calculates average price, on-time %, late %, cancellation rate, purchase frequency, products supplied, last purchase date — all deterministic, all consumed later by the Insights Agent (`AI-Agent-Plan.md`).

## 3. Warehouse Routing

Folder: `src/warehouse-inventory/` (service file split from Joseph's read service)

```
WarehouseRoutingService
└── findBestWarehouseForOrder(deliveryCountry, deliveryRegion, items)
```

Flow: delivery location → available stock → warehouses that can fulfill → location comparison → recommended warehouse.

## 4. Stock Movements

Folder: `src/stock-movements/`

```
StockMovementsService
├── recordMovement(...)
└── getLedger(filters)
```

`recordMovement()` atomically writes `StockMovement` + updates `WarehouseInventory.onHand`. No other code path may touch `onHand`.

## 5. Reservations

Folder: `src/reservations/`

```
ReservationsService
├── reserve(...)
├── release(...)
└── fulfill(...)
```

Available-stock verification, OUTGOING/TRANSFER reservations, concurrency protection, deterministic `(warehouseId, productId)` locking. Core formula: `available = onHand - ACTIVE reservations`.

## 6. Inventory Transactions

Folder: `src/inventory-transactions/`

```
InventoryTransactionsService
├── createIncoming(dto)
├── createOutgoing(dto)
├── createTransfer(dto)
├── update(id, dto)
├── complete(id)
├── cancel(id)
├── findAll(filters)
├── findOne(id)
├── getUpcomingDeliveries()
└── getOverdueTransactions()
```

`complete()` uses `WHERE id = X AND status = PENDING` plus row locking and `Prisma $transaction()`. `cancel()` only operates on PENDING and releases reservations where applicable. `update()` keeps reservations synchronized when quantity/product/source warehouse changes.

## 7. Document Review

Folder: `src/document-review/`

```
DocumentReviewService
├── upload(file)
├── approve(...)
├── reject(...)
├── getReview(id)
├── getPendingReviews()
├── resolveProduct(...)
└── resolveSupplier(...)
```

Upload validates PDF/JPG/JPEG/PNG up to 10MB, stores to S3, creates `PendingDocumentReview`. Approve resolves warehouse/supplier/products (EXISTING/CREATE) and creates a **PENDING** transaction — no stock change on approval. Reject stores `rejectionReason`, `reviewedById`, `reviewedAt`. `getReview()`/`getPendingReviews()`/`resolveProduct()`/`resolveSupplier()` are the supporting operations the review UI and Document Agent both call into during the workflow.

## 8. Stock Insights (includes adopted Work-Split-Alignment changes)

Folder: `src/stock-insights/`

```
StockInsightsService
├── getDeadStock(days)
├── getStockoutRisk()
├── getConsumptionAnomalies()
├── getRestockRecommendations()   ← refined, see below
└── getTransferRecommendations()

ControlTowerService                ← new
└── getControlTowerAlerts()
```

### `getRestockRecommendations()` — refined 3-check sequence

Per `Work-Split-Alignment.md`:

1. Confirm it nets `available = onHand − reservations`, not raw `onHand`.
2. Check incoming PO quantity + expected date.
3. Only treat another warehouse's stock as a transfer candidate if that product's turnover there is low — never suggest pulling from a warehouse actively selling it.

Returns `needsReorder`, a `reason` code (`covered_by_incoming_po` / `transfer_available` / `no_incoming_no_transfer`), and the relevant quantity/candidate.

### `getControlTowerAlerts()` — new

Aggregates `getLowStockProducts()`, `getStockoutRisk()`, `getOverdueTransactions()`, `getConsumptionAnomalies()`, and invoice/order discrepancies from Document Review into one alert array with `severity` + `evidence` per alert. Response shape (`severity`, `evidence`, `category` fields) still needs to be agreed with Ribal before the AI narration layer is built against it — see `AI-Agent-Plan.md`'s open items.

> `getExpiringInventory()` was previously considered as a Control Tower input but required new expiry-tracking schema. It has been **dropped, not just deferred** — Control Tower ships on the four inputs above only, no schema change needed.

---

## Total Function Count

**40 active functions.** No blocked items remain — `getExpiringInventory()` was dropped rather than deferred.

```
Auth / Users (7)
  validateUser()
  login()
  createUser()
  findAllUsers()
  findOneUser()
  updateUser()
  removeUser()

Supplier Intelligence (4)
  getSupplierStats()
  compareSuppliers()
  rankSuppliers()
  getBestSupplier()

Warehouse Routing (1)
  findBestWarehouseForOrder()

Stock Movements (2)
  recordMovement()
  getLedger()

Reservations (3)
  reserve()
  release()
  fulfill()

Inventory Transactions (10)
  createIncoming()
  createOutgoing()
  createTransfer()
  update()
  complete()
  cancel()
  findAllTransactions()
  findOneTransaction()
  getUpcomingDeliveries()
  getOverdueTransactions()

Document Review (7)
  upload()
  approve()
  reject()
  getReview()
  getPendingReviews()
  resolveProduct()
  resolveSupplier()

Stock Insights (6)
  getDeadStock()
  getStockoutRisk()
  getConsumptionAnomalies()
  getRestockRecommendations()   [refined 3-check logic]
  getTransferRecommendations()
  getControlTowerAlerts()       [new]
```

---

## Coordination Notes

- `suppliers/` and `warehouse-inventory/` are shared folders with Joseph — each has a dedicated service file per developer (see structure above) so you're not editing the same file.
- Shared root files (`app.module.ts`, `prisma.service.ts`, `common/`, `package.json`, `docker-compose.yml`) — coordinate with Joseph before editing.
- Every function above may later be exposed as a read-only AgentCore tool per `AI-Agent-Plan.md`'s Insights Agent tool-mapping table — implement them as plain, well-typed NestJS functions; the AI wrapping happens entirely on Ribal's side.
