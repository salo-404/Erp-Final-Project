import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../lib/useFetch";
import {
  getWarehouseAvailability,
  getWarehouseCatalog,
  getWarehouseReservedTotal,
  listWarehouses,
} from "../lib/warehouses.api";
import { getLedger } from "../lib/stockMovements.api";
import { createTransfer, listTransactions } from "../lib/inventoryTransactions.api";
import { createProduct, updateProduct } from "../lib/products.api";
import { categoryBreakdown } from "../lib/warehouseStats";
import { arrivedTotal, inventoryStatus, topProductsByStock } from "../lib/inventoryStats";
import { WarehouseSelect } from "../components/warehouses/WarehouseSelect";
import { CategoryDonut } from "../components/warehouses/CategoryDonut";
import { StockActivityCard, type ActivityMetric } from "../components/inventory/StockActivityCard";
import { TopProductsCard } from "../components/inventory/TopProductsCard";
import { ProductFormModal } from "../components/inventory/ProductFormModal";
import { TransferStockModal } from "../components/inventory/TransferStockModal";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { EditIcon, PlusIcon, SearchIcon, TransferIcon, WarehouseIcon } from "../components/ui/icons";
import { ShowMoreRow } from "../components/ui/ShowMoreRow";
import { useShowMore } from "../lib/useShowMore";
import type { CreateTransferInput, Product, Warehouse, WarehouseAvailability, WarehouseCatalog } from "../types/domain";

function sevenDaysAgoIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 16px",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--color-text-muted)",
};
const tdStyle: React.CSSProperties = { padding: "10px 16px", fontSize: 13, borderTop: "1px solid var(--color-border)" };

export function InventoryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const navigate = useNavigate();

  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [addingProduct, setAddingProduct] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [transferringRow, setTransferringRow] = useState<{ productId: number; name: string; available: number } | null>(null);

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
  const availabilityFetch = useFetch<WarehouseAvailability[]>(
    () => (selectedId !== null ? getWarehouseAvailability(selectedId) : Promise.resolve([])),
    [selectedId],
  );
  const reservedFetch = useFetch(
    () => (selectedId !== null ? getWarehouseReservedTotal(selectedId) : Promise.resolve(null)),
    [selectedId],
  );
  const ledgerFetch = useFetch(
    () => (selectedId !== null ? getLedger({ warehouseId: selectedId, dateFrom: sevenDaysAgoIso() }) : Promise.resolve([])),
    [selectedId],
  );
  const pendingIncomingFetch = useFetch(
    () =>
      selectedId !== null
        ? listTransactions({ type: "INCOMING", status: "PENDING", destinationWarehouseId: selectedId })
        : Promise.resolve([]),
    [selectedId],
  );
  const pendingTransferFetch = useFetch(
    () =>
      selectedId !== null
        ? listTransactions({ type: "TRANSFER", status: "PENDING", destinationWarehouseId: selectedId })
        : Promise.resolve([]),
    [selectedId],
  );

  const inventories = useMemo(() => catalogFetch.data?.inventories ?? [], [catalogFetch.data]);
  const availabilityByProduct = useMemo(
    () => new Map((availabilityFetch.data ?? []).map((a) => [a.productId, a])),
    [availabilityFetch.data],
  );
  const movements = useMemo(() => ledgerFetch.data ?? [], [ledgerFetch.data]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const row of inventories) set.add(row.product?.category?.trim() || "Uncategorized");
    return [...set].sort();
  }, [inventories]);

  const rows = useMemo(
    () =>
      inventories.map((row) => {
        const avail = availabilityByProduct.get(row.productId);
        const available = avail?.available ?? row.onHand;
        const reserved = avail?.reserved ?? 0;
        return {
          productId: row.productId,
          name: row.product?.name ?? `Product #${row.productId}`,
          category: row.product?.category?.trim() || "Uncategorized",
          available,
          reserved,
          onHand: row.onHand,
          status: inventoryStatus(available, row.reorderThreshold),
        };
      }),
    [inventories, availabilityByProduct],
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesSearch = !q || r.name.toLowerCase().includes(q) || `prd-${r.productId}`.includes(q);
      const matchesCategory = categoryFilter === "all" || r.category === categoryFilter;
      return matchesSearch && matchesCategory;
    });
  }, [rows, search, categoryFilter]);
  const productsShowMore = useShowMore(filteredRows, 10, 10);

  const catBreakdown = useMemo(() => categoryBreakdown(inventories), [inventories]);
  const totalUnitsVal = useMemo(() => inventories.reduce((sum, r) => sum + r.onHand, 0), [inventories]);

  const arrived = useMemo(() => arrivedTotal(movements), [movements]);

  const inTheWayTotal = useMemo(() => {
    const incoming = pendingIncomingFetch.data ?? [];
    const transfers = pendingTransferFetch.data ?? [];
    let total = 0;
    for (const tx of [...incoming, ...transfers]) {
      for (const item of tx.items) total += item.quantity;
    }
    return total;
  }, [pendingIncomingFetch.data, pendingTransferFetch.data]);

  const topProducts = useMemo(() => topProductsByStock(inventories), [inventories]);

  const activityMetrics: ActivityMetric[] = [
    { label: "Reserved", value: reservedFetch.data?.totalReserved ?? 0, sub: "currently held", color: "var(--color-accent)" },
    { label: "In The Way", value: inTheWayTotal, sub: "pending arrival", color: "var(--color-warning)" },
    { label: "Arrived", value: arrived, sub: "last 7 days", color: "var(--color-success)" },
  ];

  async function handleAddProduct(input: { name: string; category?: string; description?: string }) {
    await createProduct(input);
  }

  async function handleEditProduct(input: { name: string; category?: string; description?: string }) {
    if (!editingProduct) return;
    await updateProduct(editingProduct.id, input);
    catalogFetch.refetch();
  }

  async function handleCreateTransfer(input: CreateTransferInput) {
    await createTransfer(input);
    catalogFetch.refetch();
    availabilityFetch.refetch();
  }

  const selectedWarehouse = useMemo(() => warehouses.find((w) => w.id === selectedId) ?? null, [warehouses, selectedId]);
  const otherWarehouses = useMemo(() => warehouses.filter((w) => w.id !== selectedId), [warehouses, selectedId]);

  const detailLoading =
    catalogFetch.loading || availabilityFetch.loading || reservedFetch.loading || ledgerFetch.loading ||
    pendingIncomingFetch.loading || pendingTransferFetch.loading;
  const detailError = catalogFetch.error || availabilityFetch.error || reservedFetch.error;

  if (warehousesFetch.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading inventory..." />
      </div>
    );
  }
  if (warehousesFetch.error) {
    return <ErrorMessage message={warehousesFetch.error} onRetry={warehousesFetch.refetch} />;
  }
  if (warehouses.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <WarehouseIcon className="h-10 w-10 text-[var(--color-text-muted)]" />
        <p className="font-[var(--font-heading)] text-lg font-semibold">No warehouses yet</p>
        <p className="text-sm text-[var(--color-text-muted)]">Create a warehouse first, then inventory will show here.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <WarehouseSelect warehouses={warehouses} selectedId={selectedId} onChange={setSelectedId} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "10px 12px", width: 240 }}>
            <SearchIcon className="h-[14px] w-[14px] flex-shrink-0 text-[var(--color-text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products, SKUs..."
              style={{ border: "none", outline: "none", background: "transparent", fontSize: 13, color: "var(--color-text)", width: "100%", fontFamily: "var(--font-body)" }}
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "var(--color-text)", cursor: "pointer" }}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {detailError && (
        <ErrorMessage
          message={detailError}
          onRetry={() => {
            catalogFetch.refetch();
            availabilityFetch.refetch();
            reservedFetch.refetch();
          }}
        />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
        {detailLoading ? (
          <div style={{ gridColumn: "1 / -1", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 40 }}>
            <LoadingSpinner label="Loading stock activity..." />
          </div>
        ) : (
          <>
            <StockActivityCard metrics={activityMetrics} />

            <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 18 }}>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 12 }}>Inventory by Category</div>
              <CategoryDonut entries={catBreakdown} totalUnits={totalUnitsVal} />
            </div>

            <TopProductsCard products={topProducts} />
          </>
        )}
      </div>

      <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--color-border)", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Products</div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{filteredRows.length} products</div>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setAddingProduct(true)}
              style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, padding: "8px 14px", borderRadius: 7, background: "var(--color-accent)", color: "#FFFFFF", border: "none", cursor: "pointer" }}
            >
              <PlusIcon className="h-[14px] w-[14px]" />
              Add Product
            </button>
          )}
        </div>

        {detailLoading ? (
          <div style={{ padding: 18 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ height: 38, borderRadius: 6, background: "var(--color-surface-2)", marginBottom: 10, opacity: 0.6 }} />
            ))}
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>No products match your filters</div>
            <div style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>Try a different SKU, product name, or category.</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820, tableLayout: "fixed" }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  <th style={thStyle}>SKU</th>
                  <th style={thStyle}>Product</th>
                  <th style={thStyle}>Category</th>
                  <th style={{ ...thStyle, textAlign: "center" }}>Available</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {productsShowMore.visible.map((row) => (
                  <tr key={row.productId}>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)" }}>
                      PRD-{row.productId}
                    </td>
                    <td
                      onClick={() => navigate(`/products/${row.productId}`)}
                      style={{ ...tdStyle, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                      {row.name}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--color-text-secondary)", fontSize: 12.5 }}>{row.category}</td>
                    <td style={{ ...tdStyle, textAlign: "center", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13.5 }}>
                      {row.available}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: row.status.bg, color: row.status.color, letterSpacing: "0.04em", whiteSpace: "nowrap" }}
                      >
                        {row.status.label}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      <div style={{ display: "inline-flex", gap: 6, justifyContent: "center" }}>
                        <button
                          type="button"
                          title="View"
                          onClick={() => navigate(`/products/${row.productId}`)}
                          style={{ width: 26, height: 26, borderRadius: 6, background: "var(--color-surface-2)", border: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--color-text-secondary)" }}
                        >
                          <SearchIcon className="h-[13px] w-[13px]" />
                        </button>
                        {isAdmin && (
                          <button
                            type="button"
                            title="Edit"
                            onClick={() => {
                              const original = inventories.find((i) => i.productId === row.productId)?.product;
                              if (original) setEditingProduct(original);
                            }}
                            style={{ width: 26, height: 26, borderRadius: 6, background: "var(--color-surface-2)", border: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--color-text-secondary)" }}
                          >
                            <EditIcon className="h-[13px] w-[13px]" />
                          </button>
                        )}
                        <button
                          type="button"
                          title="Transfer"
                          disabled={row.available <= 0 || otherWarehouses.length === 0}
                          onClick={() => setTransferringRow({ productId: row.productId, name: row.name, available: row.available })}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 6,
                            background: "var(--color-surface-2)",
                            border: "1px solid var(--color-border)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: row.available <= 0 || otherWarehouses.length === 0 ? "default" : "pointer",
                            opacity: row.available <= 0 || otherWarehouses.length === 0 ? 0.4 : 1,
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          <TransferIcon className="h-[13px] w-[13px]" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                <ShowMoreRow colSpan={6} shown={productsShowMore.shown} total={productsShowMore.total} onShowMore={productsShowMore.showMore} />
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addingProduct && (
        <ProductFormModal product={null} onClose={() => setAddingProduct(false)} onSubmit={handleAddProduct} />
      )}
      {editingProduct && (
        <ProductFormModal product={editingProduct} onClose={() => setEditingProduct(null)} onSubmit={handleEditProduct} />
      )}
      {transferringRow && selectedWarehouse && (
        <TransferStockModal
          productId={transferringRow.productId}
          productName={transferringRow.name}
          available={transferringRow.available}
          sourceWarehouse={selectedWarehouse}
          destinationWarehouses={otherWarehouses}
          onClose={() => setTransferringRow(null)}
          onSubmit={handleCreateTransfer}
        />
      )}
    </div>
  );
}
