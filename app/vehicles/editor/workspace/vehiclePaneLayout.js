/**
 * Pane layout for the vehicle editor. Hierarchy and inspector flank the
 * studio. Sizes are preferences, not part of the vehicle manifest.
 */

import { CENTER_MIN, PANE_LIMITS, PANE_STEP } from "../../../3d/editor/workspace/paneLayout.js";

export { CENTER_MIN, PANE_LIMITS, PANE_STEP };

export const VEHICLE_PANE_LAYOUT_VERSION = 1;
export const VEHICLE_PANE_IDS = Object.freeze(["hierarchy", "inspector"]);
export const VEHICLE_WORKSPACE_CHROME = Object.freeze({ topBar: 40, toolbar: 36, splitter: 6, rail: 28 });

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampSize(id, size) {
    const limits = PANE_LIMITS[id];
    return Math.round(Math.min(limits.max, Math.max(limits.min, finite(size, limits.default))));
}

export function createDefaultVehiclePaneLayout() {
    const panes = {};
    for (const id of VEHICLE_PANE_IDS) panes[id] = { size: PANE_LIMITS[id].default, collapsed: false };
    return { version: VEHICLE_PANE_LAYOUT_VERSION, panes };
}

export function normalizeVehiclePaneLayout(raw) {
    const layout = createDefaultVehiclePaneLayout();
    const source = raw && typeof raw === "object" ? (raw.panes && typeof raw.panes === "object" ? raw.panes : raw) : {};
    for (const id of VEHICLE_PANE_IDS) {
        const pane = source[id];
        if (!pane || typeof pane !== "object") continue;
        layout.panes[id] = {
            size: clampSize(id, pane.size),
            collapsed: pane.collapsed === true,
        };
    }
    return layout;
}

export function vehiclePaneExtent(layout, id, chrome = VEHICLE_WORKSPACE_CHROME) {
    const pane = normalizeVehiclePaneLayout(layout).panes[id];
    return pane.collapsed ? chrome.rail : pane.size;
}

export function clampVehiclePaneLayout(layout, viewport, chrome = VEHICLE_WORKSPACE_CHROME) {
    const next = normalizeVehiclePaneLayout(layout);
    const width = finite(viewport?.width, Infinity);
    const centerWidth = () => width - vehiclePaneExtent(next, "hierarchy", chrome) - vehiclePaneExtent(next, "inspector", chrome) - 2 * chrome.splitter;
    for (const id of ["inspector", "hierarchy"]) {
        if (centerWidth() >= CENTER_MIN.width || next.panes[id].collapsed) continue;
        const deficit = CENTER_MIN.width - centerWidth();
        next.panes[id].size = clampSize(id, next.panes[id].size - deficit);
    }
    for (const id of ["inspector", "hierarchy"]) {
        if (centerWidth() >= CENTER_MIN.width) break;
        next.panes[id].collapsed = true;
    }
    return next;
}

export function resizeVehiclePane(layout, id, size, viewport = null, chrome = VEHICLE_WORKSPACE_CHROME) {
    if (!VEHICLE_PANE_IDS.includes(id)) return normalizeVehiclePaneLayout(layout);
    const next = normalizeVehiclePaneLayout(layout);
    next.panes[id] = { size: clampSize(id, size), collapsed: false };
    return viewport ? clampVehiclePaneLayout(next, viewport, chrome) : next;
}

export function stepVehiclePaneSize(layout, id, direction, { large = false, viewport = null } = {}) {
    const step = (large ? PANE_STEP.large : PANE_STEP.small) * (direction < 0 ? -1 : 1);
    return resizeVehiclePane(layout, id, normalizeVehiclePaneLayout(layout).panes[id].size + step, viewport);
}

export function toggleVehiclePane(layout, id, collapsed = undefined) {
    if (!VEHICLE_PANE_IDS.includes(id)) return normalizeVehiclePaneLayout(layout);
    const next = normalizeVehiclePaneLayout(layout);
    next.panes[id].collapsed = collapsed === undefined ? !next.panes[id].collapsed : collapsed === true;
    return next;
}

export function resetVehiclePane(layout, id) {
    if (!VEHICLE_PANE_IDS.includes(id)) return normalizeVehiclePaneLayout(layout);
    const next = normalizeVehiclePaneLayout(layout);
    next.panes[id] = { size: PANE_LIMITS[id].default, collapsed: false };
    return next;
}

export function vehiclePaneGridTemplate(layout, chrome = VEHICLE_WORKSPACE_CHROME) {
    return {
        columns: `${vehiclePaneExtent(layout, "hierarchy", chrome)}px ${chrome.splitter}px minmax(0, 1fr) ${chrome.splitter}px ${vehiclePaneExtent(layout, "inspector", chrome)}px`,
        rows: `${chrome.topBar}px ${chrome.toolbar}px minmax(0, 1fr)`,
    };
}

export function vehicleSplitterAria(layout, id) {
    const pane = normalizeVehiclePaneLayout(layout).panes[id];
    const limits = PANE_LIMITS[id];
    return {
        orientation: "vertical",
        valuenow: pane.collapsed ? 0 : pane.size,
        valuemin: limits.min,
        valuemax: limits.max,
    };
}

export function vehiclePaneLayoutsEqual(left, right) {
    const a = normalizeVehiclePaneLayout(left);
    const b = normalizeVehiclePaneLayout(right);
    return VEHICLE_PANE_IDS.every((id) => a.panes[id].size === b.panes[id].size && a.panes[id].collapsed === b.panes[id].collapsed);
}
