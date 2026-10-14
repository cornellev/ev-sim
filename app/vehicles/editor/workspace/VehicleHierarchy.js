'use client';

import {
    IconAntennaBars5,
    IconBox,
    IconCamera,
    IconCompass,
    IconComponents,
    IconCube,
    IconGripHorizontal,
    IconHexagon,
    IconRadar2,
    IconSatellite,
    IconWheel,
} from "@tabler/icons-react";
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

const KIND_ICONS = {
    body: IconBox,
    model: IconCube,
    "model-node": IconComponents,
    axle: IconGripHorizontal,
    wheel: IconWheel,
    lidar: IconHexagon,
};

function sensorIcon(type) {
    const id = String(type || "");
    if (id.startsWith("camera")) return IconCamera;
    if (id.startsWith("lidar")) return IconRadar2;
    if (id.startsWith("imu")) return IconCompass;
    if (id.startsWith("gnss") || id.startsWith("gps")) return IconSatellite;
    return IconAntennaBars5;
}

function rowIcon(row) {
    if (row.kind === "sensor") return sensorIcon(row.sensorType);
    return KIND_ICONS[row.kind] ?? IconBox;
}

export function VehicleHierarchy({ manifest, nodes, selection, onSelect, linkedIds = [] }) {
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
        if (row.kind === "axle") return selection.kind === "axle" && selection.id === row.id.replace(/^axle-/, "");
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
            {rows.map((row) => {
                const Icon = rowIcon(row);
                const selected = isSelected(row);
                const linked = row.kind === "wheel" && linkedIds.includes(row.id) && !selected;
                const tone = selected
                    ? "bg-[var(--slate-surface-3)]"
                    : linked
                        ? "bg-[var(--slate-surface-2)]"
                        : "hover:bg-[var(--slate-surface-2)]";
                return (
                    <button
                        key={row.id}
                        type="button"
                        role="treeitem"
                        aria-selected={selected}
                        data-linked={linked ? "true" : undefined}
                        disabled={row.disabled}
                        className={`flex w-full items-center gap-1.5 rounded-[var(--radius)] px-2 py-1.5 text-left text-[12px] ${tone}`}
                        style={{ paddingLeft: 8 + row.depth * 14 }}
                        onClick={() => onSelect(row, TAB_FOR_KIND[row.kind])}
                    >
                        <Icon className="h-3 w-3 shrink-0 text-[var(--slate-muted)]" aria-hidden="true" />
                        <span className="truncate">{row.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
