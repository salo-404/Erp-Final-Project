import type { View } from "../App";

interface SidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
}

const NAV_ITEMS: Array<{ view: View; label: string; icon: string }> = [
  { view: "warehouses", label: "Warehouses", icon: "🏬" },
  { view: "orders", label: "Orders", icon: "📦" },
  { view: "control-tower", label: "Control Tower", icon: "🛰️" },
  { view: "suppliers", label: "Suppliers", icon: "🤝" },
  { view: "settings", label: "Settings", icon: "⚙️" },
];

/**
 * Left navigation rail. Purely local view-switching (see App.tsx's `view`
 * state) - no routing library, no page reloads.
 */
export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <aside className="flex h-screen w-56 flex-shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="px-5 py-6">
        <p className="text-sm font-semibold tracking-wide text-zinc-100">Mini ERP</p>
        <p className="text-xs text-zinc-500">UI mockup</p>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => {
          const isActive =
            activeView === item.view ||
            (item.view === "warehouses" && activeView === "warehouse-detail");
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => onNavigate(item.view)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                isActive
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="px-5 py-4 text-xs text-zinc-600">Mock data only</div>
    </aside>
  );
}
