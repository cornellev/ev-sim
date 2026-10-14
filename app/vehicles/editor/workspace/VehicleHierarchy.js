'use client';

import { buildVehicleHierarchy } from "./vehicleHierarchyModel.js";

const TAB_FOR_KIND = {
    body: "Body",
    model: "Model",
    "model-node": "Model",
    axle: "Wheels",
    wheel: "Wheels",
    sensor: "Sensors",
    lidar: "LiDAR Zone",
};

export function VehicleHierarchy({ manifest, nodes, selection, onSelect }) {
    const rows = buildVehicleHierarchy(manifest, { nodes });
    const onKeyDown = (event) => {
        const current = rows.findIndex((row) => row.id === selection?.id || (selection?.kind === row.kind && !selection?.id && row.kind === "body"));
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End"
                ? rows.length - 1
                : Math.min(rows.length - 1, Math.max(0, (current < 0 ? 0 : current) + (event.key === "ArrowDown" ? 1 : -1)));
        const row = rows[nextIndex];
        if (row) onSelect(row, TAB_FOR_KIND[row.kind]);
    };
    const isSelected = (row) => {
        if (!selection?.kind) return false;
        if (row.kind === "wheel" || row.kind === "sensor") return selection.kind === row.kind && selection.id === row.id;
        if (row.kind === "model-node") return selection.kind === "model";
        return selection.kind === row.kind;
    };
    return (
        <div
            role="tree"
            aria-label="Vehicle hierarchy"
            tabIndex={0}
            className="mod-scrollbar h-full overflow-y-auto p-1 outline-none"
            onKeyDown={onKeyDown}
        >
            {rows.map((row) => (
                <button
                    key={row.id}
                    type="button"
                    role="treeitem"
                    aria-selected={isSelected(row)}
                    disabled={row.disabled}
                    className={`flex w-full rounded-[var(--radius)] px-2 py-1.5 text-left text-[12px] ${isSelected(row) ? "bg-[var(--slate-surface-3)]" : "hover:bg-[var(--slate-surface-2)]"}`}
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                    onClick={() => onSelect(row, TAB_FOR_KIND[row.kind])}
                >
                    <span className="truncate">{row.label}</span>
                </button>
            ))}
        </div>
    );
}
