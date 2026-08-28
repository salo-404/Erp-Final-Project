import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../lib/useFetch";
import {
  createWarehouse,
  deleteWarehouse,
  getWarehouseCapacity,
  getWarehouseCatalog,
  listWarehouses,
  updateWarehouse,
} from "../lib/warehouses.api";
import { getLedger } from "../lib/stockMovements.api";
import { listTransfers } from "../lib/inventoryTransactions.api";
import {
  activeSkuCount,
  capacityPercent,
  capacityStatus,
  categoryBreakdown,
  currentMonthThroughput,
  monthlyThroughput,
  totalUnits,
} from "../lib/warehouseStats";
import { CategoryDonut } from "../components/warehouses/CategoryDonut";
import { ThroughputChart } from "../components/warehouses/ThroughputChart";
import { MovementLedger } from "../components/warehouses/MovementLedger";
import { WarehouseFormModal } from "../components/warehouses/WarehouseFormModal";
import { WarehouseSelect } from "../components/warehouses/WarehouseSelect";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import {
  EditIcon,
  InventoryIcon,
  PinIcon,
  PlusIcon,
  StockMovementsIcon,
  TransactionsIcon,
  TrashIcon,
  WarehouseIcon,
} from "../components/ui/icons";
import type { Warehouse, WarehouseCatalog, WarehouseCapacity } from "../types/domain";
import warehouseHero from "../assets/warehouse-hero.png";

function elevenMonthsAgoIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 11, 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function WarehousesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);

  useEffect(() => {
    if (!warehousesFetch.loading && warehouses.length > 0 && selectedId === null) {
      setSelectedId(warehouses[0].id);
    }
    if (!warehousesFetch.loading && warehouses.length > 0 && selectedId !== null && !warehouses.some((w) => w.id === selectedId)) {
      setSelectedId(warehouses[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehousesFetch.loading, warehouses.length, selectedId]);

  const catalogFetch = useFetch<WarehouseCatalog | null>(
    () => (selectedId !== null ? getWarehouseCatalog(selectedId) : Promise.resolve(null)),
    [selectedId],
  );
  const capacityFetch = useFetch<WarehouseCapacity | null>(
    () => (selectedId !== null ? getWarehouseCapacity(selectedId) : Promise.resolve(null)),
    [selectedId],
  );
  const ledgerFetch = useFetch(
    () => (selectedId !== null ? getLedger({ warehouseId: selectedId, dateFrom: elevenMonthsAgoIso() }) : Promise.resolve([])),
    [selectedId],
  );
  const transfersFetch = useFetch(() => listTransfers(), []);

  const selectedWarehouse = warehouses.find((w) => w.id === selectedId) ?? null;
  const inventories = useMemo(() => catalogFetch.data?.inventories ?? [], [catalogFetch.data]);
  const movements = useMemo(() => ledgerFetch.data ?? [], [ledgerFetch.data]);

  const productNames = useMemo(
    () => new Map(inventories.map((i) => [i.productId, i.product?.name ?? `Product #${i.productId}`])),
    [inventories],
  );
  const warehouseNames = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);

  const capacity = capacityFetch.data;
  const status = capacity ? capacityStatus(capacity) : null;
  const pct = capacity ? capacityPercent(capacity) : 0;
  const catBreakdown = useMemo(() => categoryBreakdown(inventories), [inventories]);
  const months = useMemo(() => monthlyThroughput(movements), [movements]);
  const totalUnitsVal = totalUnits(inventories);
  const activeSkus = activeSkuCount(inventories);
  const thisMonthThroughput = currentMonthThroughput(movements);

  async function handleCreate(input: { name: string; location?: string; maxCapacity?: number }) {
    const created = await createWarehouse(input);
    await warehousesFetch.refetch();
    setSelectedId(created.id);
  }

  async function handleUpdate(input: { name: string; location?: string; maxCapacity?: number }) {
    if (selectedId === null) return;
    await updateWarehouse(selectedId, input);
    await warehousesFetch.refetch();
    catalogFetch.refetch();
    capacityFetch.refetch();
  }

  async function handleDelete() {
    if (selectedId === null) return;
    const deletedId = selectedId;
    await deleteWarehouse(deletedId);
    const fresh = await listWarehouses();
    setSelectedId(fresh.find((w) => w.id !== deletedId)?.id ?? fresh[0]?.id ?? null);
    warehousesFetch.refetch();
    setConfirmingDelete(false);
  }

  if (warehousesFetch.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading warehouses..." />
      </div>
    );
  }

  if (warehousesFetch.error) {
    return <ErrorMessage message={warehousesFetch.error} onRetry={warehousesFetch.refetch} />;
  }

  if (warehouses.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <WarehouseIcon className="h-10 w-10 text-[var(--color-text-muted)]" />
        <div>
          <p className="font-[var(--font-heading)] text-lg font-semibold">No warehouses yet</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">Create your first warehouse to get started.</p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setFormMode("create")}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-on-accent)]"
          >
            Create Warehouse
          </button>
        )}
        {formMode === "create" && (
          <WarehouseFormModal warehouse={null} onClose={() => setFormMode(null)} onSubmit={handleCreate} />
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <WarehouseSelect warehouses={warehouses} selectedId={selectedId} onChange={setSelectedId} />

        {isAdmin && (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={() => setFormMode("create")}
              style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, padding: "10px 16px", borderRadius: 8, background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", cursor: "pointer" }}
            >
              <PlusIcon className="h-[14px] w-[14px]" />
              Create Warehouse
            </button>
            <button
              type="button"
              onClick={() => setFormMode("edit")}
              disabled={!selectedWarehouse}
              style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, padding: "10px 16px", borderRadius: 8, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", cursor: "pointer" }}
            >
              <EditIcon className="h-[14px] w-[14px]" />
              Edit
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!selectedWarehouse}
              style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, padding: "10px 16px", borderRadius: 8, background: "transparent", border: "1px solid rgba(239,68,68,0.35)", color: "var(--color-danger)", cursor: "pointer" }}
            >
              <TrashIcon className="h-[14px] w-[14px]" />
              Delete
            </button>
          </div>
        )}
      </div>

      {(catalogFetch.error || capacityFetch.error) && (
        <ErrorMessage
          message={catalogFetch.error ?? capacityFetch.error ?? "Failed to load warehouse detail."}
          onRetry={() => {
            catalogFetch.refetch();
            capacityFetch.refetch();
          }}
        />
      )}

      {selectedWarehouse && (
        <div
          style={{
            position: "relative",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 14,
            padding: 28,
            minHeight: 180,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `url(${warehouseHero})`,
              backgroundSize: "cover",
              backgroundPosition: "right center",
              backgroundRepeat: "no-repeat",
              opacity: 0.9,
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(90deg, var(--color-surface) 0%, var(--color-surface) 45%, transparent 100%)",
              pointerEvents: "none",
            }}
          />
          <div style={{ position: "relative" }}>
          {catalogFetch.loading || capacityFetch.loading ? (
            <LoadingSpinner label="Loading warehouse detail..." />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 30 }}>{selectedWarehouse.name}</div>
                {status && (
                  <div style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 14, background: status.bg, color: status.color, letterSpacing: "0.04em" }}>
                    {status.label.toUpperCase()}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-text-secondary)", fontSize: 13.5, marginBottom: 24, fontWeight: 500 }}>
                <PinIcon className="h-[14px] w-[14px] text-[var(--color-accent)]" />
                {selectedWarehouse.location || "No location set"}
              </div>

              <div style={{ display: "flex", gap: 36, flexWrap: "wrap", paddingTop: 20, borderTop: "1px solid var(--color-border)", maxWidth: 820 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                    Established
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {new Date(selectedWarehouse.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                  </div>
                </div>
                {capacity && (
                  <div style={{ minWidth: 180 }}>
                    <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                      Capacity Utilization
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: status?.color, fontFamily: "var(--font-mono)" }}>
                        {capacity.maxCapacity !== null ? `${pct}%` : "—"}
                      </div>
                      <div style={{ flex: 1, height: 6, background: "var(--color-border)", borderRadius: 3, overflow: "hidden", minWidth: 80 }}>
                        <div style={{ width: `${capacity.maxCapacity !== null ? pct : 0}%`, height: "100%", background: status?.color }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        {[
          { label: "Total Units", value: totalUnitsVal.toLocaleString(), sub: "across all SKUs", Icon: InventoryIcon },
          {
            label: "Capacity",
            value: capacity?.maxCapacity != null ? `${pct}%` : "—",
            sub: capacity?.maxCapacity != null ? `${capacity.currentStock.toLocaleString()} / ${capacity.maxCapacity.toLocaleString()} units` : "No limit set",
            Icon: WarehouseIcon,
          },
          { label: "Active SKUs", value: String(activeSkus), sub: `${inventories.length} tracked`, Icon: StockMovementsIcon },
          { label: "Monthly Throughput", value: thisMonthThroughput.toLocaleString(), sub: "units this month", Icon: TransactionsIcon },
        ].map((kpi) => (
          <div key={kpi.label} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--color-accent-tint)", color: "var(--color-accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <kpi.Icon className="h-4 w-4" />
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{kpi.label}</div>
            </div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 24 }}>
              {catalogFetch.loading || capacityFetch.loading ? "…" : kpi.value}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 4 }}>{kpi.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
        <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Inventory Overview</div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>by category</div>
          </div>
          {catalogFetch.loading ? <LoadingSpinner /> : <CategoryDonut entries={catBreakdown} totalUnits={totalUnitsVal} />}
        </div>

        <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Throughput (12mo)</div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>units/month</div>
          </div>
          {ledgerFetch.loading ? <LoadingSpinner /> : <ThroughputChart months={months} />}
        </div>
      </div>

      {ledgerFetch.error ? (
        <ErrorMessage message={ledgerFetch.error} onRetry={ledgerFetch.refetch} />
      ) : ledgerFetch.loading ? (
        <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 40 }}>
          <LoadingSpinner label="Loading movement ledger..." />
        </div>
      ) : (
        selectedId !== null && (
          <MovementLedger
            movements={movements}
            productNames={productNames}
            warehouseNames={warehouseNames}
            transfers={transfersFetch.data ?? []}
            currentWarehouseId={selectedId}
          />
        )
      )}

      {formMode && (
        <WarehouseFormModal
          warehouse={formMode === "edit" ? selectedWarehouse : null}
          onClose={() => setFormMode(null)}
          onSubmit={formMode === "edit" ? handleUpdate : handleCreate}
        />
      )}

      {confirmingDelete && selectedWarehouse && (
        <ConfirmDialog
          title="Delete Warehouse"
          message={`Delete "${selectedWarehouse.name}"? If it has related inventory or transactions it will be deactivated instead of removed.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
