import { ChevronDownIcon, WarehouseIcon } from "../ui/icons";
import type { Warehouse } from "../../types/domain";

interface WarehouseSelectProps {
  warehouses: Warehouse[];
  selectedId: number | null;
  onChange: (id: number) => void;
}

export function WarehouseSelect({ warehouses, selectedId, onChange }: WarehouseSelectProps) {
  return (
    <div style={{ flex: 1, minWidth: 280, maxWidth: 420, position: "relative" }}>
      <select
        value={selectedId ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          appearance: "none",
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text)",
          fontFamily: "var(--font-heading)",
          fontSize: 15,
          fontWeight: 600,
          padding: "14px 44px 14px 50px",
          borderRadius: 10,
          cursor: "pointer",
        }}
      >
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <div
        style={{
          position: "absolute",
          left: 12,
          top: "50%",
          transform: "translateY(-50%)",
          width: 28,
          height: 28,
          background: "rgba(109,63,217,0.15)",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-accent)",
          pointerEvents: "none",
        }}
      >
        <WarehouseIcon className="h-4 w-4" />
      </div>
      <div style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--color-text-muted)", pointerEvents: "none" }}>
        <ChevronDownIcon className="h-4 w-4" />
      </div>
    </div>
  );
}
