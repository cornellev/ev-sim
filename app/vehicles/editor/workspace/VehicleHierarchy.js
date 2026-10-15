'use client';

import {
    IconAntennaBars5,
    IconBox,
    IconCamera,
    IconCompass,
    IconComponents,
    IconCube,
    IconEye,
    IconEyeOff,
    IconGripHorizontal,
    IconHexagon,
    IconRadar2,
    IconSatellite,
    IconWheel,
} from "@tabler/icons-react";
import { buildVehicleHierarchy, hierarchyVisibilityKey } from "./vehicleHierarchyModel.js";

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
    const family = id.includes(".") ? id.split(".").at(-1) : id;
    if (family.startsWith("camera")) return IconCamera;
    if (family.startsWith("lidar")) return IconRadar2;
    if (family.startsWith("imu")) return IconCompass;
    if (family.startsWith("gnss") || family.startsWith("gps")) return IconSatellite;
    return IconAntennaBars5;
}

function rowIcon(row) {
    if (row.kind === "sensor") return sensorIcon(row.sensorType);
    return KIND_ICONS[row.kind] ?? IconBox;
}

function selectionMatchesRow(row, selection) {
    if (!selection?.kind) return false;
    if (row.kind === "wheel" || row.kind === "sensor") return selection.kind === row.kind && selection.id === row.id;
    if (row.kind === "axle") return selection.kind === "axle" && selection.id === row.id.replace(/^axle-/, "");
    if (row.kind === "model-node") return selection.kind === "model";
    return selection.kind === row.kind;
}

export function VehicleHierarchy({ manifest, nodes, selection, onSelect, onToggleHidden, linkedIds = [], hiddenIds = [] }) {
    const rows = buildVehicleHierarchy(manifest, { nodes, hiddenIds });
    const onKeyDown = (event) => {
        const current = rows.findIndex((row) => selectionMatchesRow(row, selection));
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
    const isSelected = (row) => selectionMatchesRow(row, selection);
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
                const EyeIcon = row.ownHidden ? IconEyeOff : IconEye;
                return (
                    <div
                        key={hierarchyVisibilityKey(row.kind, row.id)}
                        role="treeitem"
                        aria-selected={selected}
                        data-linked={linked ? "true" : undefined}
                        className={`flex w-full items-center gap-1 rounded-[var(--radius)] py-1 pr-1 text-left text-[12px] ${tone} ${row.hidden ? "opacity-45" : ""}`}
                        style={{ paddingLeft: 8 + row.depth * 14 }}
                    >
                        <button
                            type="button"
                            disabled={row.disabled}
                            className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left disabled:cursor-default"
                            onClick={() => onSelect(row, TAB_FOR_KIND[row.kind])}
                        >
                            <Icon className="h-3 w-3 shrink-0 text-[var(--slate-muted)]" aria-hidden="true" />
                            <span className="truncate">{row.label}</span>
                        </button>
                        <button
                            type="button"
                            tabIndex={-1}
                            className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center text-[var(--slate-muted)] hover:text-[var(--slate-fg)]"
                            aria-label={row.ownHidden ? `Show ${row.label}` : `Hide ${row.label}`}
                            aria-pressed={row.ownHidden}
                            title={row.ownHidden ? "Show" : "Hide"}
                            onClick={(event) => {
                                event.stopPropagation();
                                onToggleHidden?.(row);
                            }}
                        >
                            <EyeIcon className="h-3 w-3" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
