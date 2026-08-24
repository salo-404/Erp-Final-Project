import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  AiAgentIcon,
  AnalyticsIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ControlTowerIcon,
  DocumentReviewIcon,
  InventoryIcon,
  SettingsIcon,
  SuppliersIcon,
  TransactionsIcon,
  TransferIcon,
  WarehouseIcon,
} from "../ui/icons";
import type { ComponentType, SVGProps } from "react";

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Categories per NEXORA_SPEC.md §4: Overview → Operations → Procurement →
// Intelligence → System. Routes point at real backend-backed modules, not
// the spec's fictional page list — see the frontend/claude_plan gap analysis.
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/", label: "Control Tower", Icon: ControlTowerIcon }],
  },
  {
    label: "Operations",
    items: [
      { to: "/warehouses", label: "Warehouses", Icon: WarehouseIcon },
      { to: "/inventory", label: "Inventory", Icon: InventoryIcon },
      { to: "/transfers", label: "Transfers", Icon: TransferIcon },
      { to: "/calendar", label: "Calendar", Icon: CalendarIcon },
    ],
  },
  {
    label: "Procurement",
    items: [
      { to: "/suppliers", label: "Suppliers", Icon: SuppliersIcon },
      { to: "/orders", label: "Orders", Icon: TransactionsIcon },
      { to: "/document-review", label: "Document Review", Icon: DocumentReviewIcon },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { to: "/analytics", label: "Analytics", Icon: AnalyticsIcon },
      { to: "/ai-agent", label: "AI Agent", Icon: AiAgentIcon },
    ],
  },
  {
    label: "System",
    items: [{ to: "/settings", label: "Settings", Icon: SettingsIcon }],
  },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`flex h-screen flex-shrink-0 flex-col border-r border-white/10 bg-[var(--color-sidebar-bg)] text-[var(--color-sidebar-text)] transition-all ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div className="flex items-center justify-between px-4 py-5">
        {!collapsed && (
          <div>
            <p className="font-[var(--font-heading)] text-sm font-bold tracking-wide">Nexora</p>
            <p className="text-xs text-white/50">Mini ERP</p>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
        >
          {collapsed ? <ChevronRightIcon className="h-4 w-4" /> : <ChevronLeftIcon className="h-4 w-4" />}
        </button>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">
                {group.label}
              </p>
            )}
            <div className="space-y-1">
              {group.items.map(({ to, label, Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                      isActive ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"
                    }`
                  }
                  title={collapsed ? label : undefined}
                >
                  <Icon className="h-[18px] w-[18px] flex-shrink-0" />
                  {!collapsed && label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
