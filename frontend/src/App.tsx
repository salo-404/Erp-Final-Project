import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { ThemeProvider } from "./theme/ThemeContext";
import { DisplayNameProvider } from "./settings/DisplayNameContext";
import { AgentProvider } from "./agent/AgentContext";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { ControlTowerPage } from "./pages/ControlTowerPage";
import { WarehousesPage } from "./pages/WarehousesPage";
import { InventoryPage } from "./pages/InventoryPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";
import { SuppliersPage } from "./pages/SuppliersPage";
import { OrdersPage } from "./pages/OrdersPage";
import { TransfersPage } from "./pages/TransfersPage";
import { DocumentReviewPage } from "./pages/DocumentReviewPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { AiAgentPage } from "./pages/AiAgentPage";
import { SettingsPage } from "./pages/SettingsPage";
import { NotFoundPage } from "./pages/NotFoundPage";

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <DisplayNameProvider>
              <AgentProvider>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />

                  <Route element={<ProtectedRoute />}>
                    <Route element={<AppShell />}>
                      <Route path="/" element={<ControlTowerPage />} />
                      <Route path="/warehouses" element={<WarehousesPage />} />
                      <Route path="/inventory" element={<InventoryPage />} />
                      <Route path="/transfers" element={<TransfersPage />} />
                      <Route path="/products/:id" element={<ProductDetailPage />} />
                      <Route path="/suppliers" element={<SuppliersPage />} />
                      <Route path="/orders" element={<OrdersPage />} />
                      <Route path="/document-review" element={<DocumentReviewPage />} />
                      <Route path="/document-review/:id" element={<DocumentReviewPage />} />
                      <Route path="/analytics" element={<AnalyticsPage />} />
                      <Route path="/calendar" element={<CalendarPage />} />
                      <Route path="/ai-agent" element={<AiAgentPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                    </Route>
                  </Route>

                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </AgentProvider>
            </DisplayNameProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
