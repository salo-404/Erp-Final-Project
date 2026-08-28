import { useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { Sidebar } from "./components/Sidebar";
import { AppDataProvider } from "./data/AppDataContext";
import { ControlTowerPage } from "./pages/ControlTowerPage";
import { OrdersPage } from "./pages/OrdersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SuppliersPage } from "./pages/SuppliersPage";
import { WarehouseDetailPage } from "./pages/WarehouseDetailPage";
import { WarehousesPage } from "./pages/WarehousesPage";

export type View =
  | "warehouses"
  | "warehouse-detail"
  | "orders"
  | "control-tower"
  | "suppliers"
  | "settings";

/**
 * App shell: sidebar + single-page view switching (local state, no router,
 * no page reloads) + the floating chat panel. All data lives in
 * AppDataProvider (in-memory mock state only - see data/AppDataContext.tsx).
 */
function App() {
  const [view, setView] = useState<View>("warehouses");
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>(null);

  function navigate(nextView: View) {
    setView(nextView);
    if (nextView !== "warehouse-detail") {
      setSelectedWarehouseId(null);
    }
  }

  function openWarehouse(warehouseId: string) {
    setSelectedWarehouseId(warehouseId);
    setView("warehouse-detail");
  }

  return (
    <AppDataProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-black text-zinc-100">
        <Sidebar activeView={view} onNavigate={navigate} />

        <main className="min-w-0 flex-1 overflow-hidden p-6">
          {view === "warehouses" && <WarehousesPage onOpenWarehouse={openWarehouse} />}
          {view === "warehouse-detail" && selectedWarehouseId && (
            <WarehouseDetailPage
              warehouseId={selectedWarehouseId}
              onBack={() => navigate("warehouses")}
            />
          )}
          {view === "orders" && <OrdersPage />}
          {view === "control-tower" && <ControlTowerPage />}
          {view === "suppliers" && <SuppliersPage />}
          {view === "settings" && <SettingsPage />}
        </main>

        <ChatPanel />
      </div>
    </AppDataProvider>
  );
}

export default App;
