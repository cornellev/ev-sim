/**
 * Pane layout model for the environment editor workspace: a fixed
 * arrangement (hierarchy left, inspector right, asset pane bottom, scene in
 * the middle) whose pane sizes and collapsed states are editor preferences.
 * Pure: no React or DOM. Sizes are CSS pixels.
 */

export const PANE_LAYOUT_VERSION = 1;

export const PANE_IDS = Object.freeze(["hierarchy", "inspector", "assets"]);

export const PANE_LIMITS = Object.freeze({
    hierarchy: Object.freeze({ default: 232, min: 180, max: 480, axis: "x" }),
    inspector: Object.freeze({ default: 304, min: 240, max: 560, axis: "x" }),
    assets: Object.freeze({ default: 208, min: 120, max: 480, axis: "y" }),
});

/** Fixed chrome around the center pane. */
export const WORKSPACE_CHROME = Object.freeze({ topBar: 40, toolbar: 36, splitter: 6, rail: 28 });

/** The scene pane never shrinks below this; panes give way first. */
export const CENTER_MIN = Object.freeze({ width: 480, height: 240 });

export const PANE_STEP = Object.freeze({ small: 8, large: 32 });

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampSize(id, size) {
    const limits = PANE_LIMITS[id];
    return Math.round(Math.min(limits.max, Math.max(limits.min, finite(size, limits.default))));
}

export function createDefaultPaneLayout() {
    const panes = {};
    for (const id of PANE_IDS) panes[id] = { size: PANE_LIMITS[id].default, collapsed: false };
    return { version: PANE_LAYOUT_VERSION, panes };
}

/** Tolerant normalization of stored or partial layouts. */
export function normalizePaneLayout(raw) {
    const layout = createDefaultPaneLayout();
    const source = raw && typeof raw === "object" ? (raw.panes && typeof raw.panes === "object" ? raw.panes : raw) : {};
    for (const id of PANE_IDS) {
        const pane = source[id];
        if (!pane || typeof pane !== "object") continue;
        layout.panes[id] = {
            size: clampSize(id, pane.size),
            collapsed: pane.collapsed === true,
        };
    }
    return layout;
}

/** Space a pane occupies along its axis: its size, or the rail when collapsed. */
export function paneExtent(layout, id, chrome = WORKSPACE_CHROME) {
    const pane = layout.panes[id];
    return pane.collapsed ? chrome.rail : pane.size;
}

/**
 * Keep the center pane at or above `CENTER_MIN` for a viewport: shrink the
 * inspector, then the hierarchy, then the asset pane to their minimums;
 * collapse them in the same order when that is still not enough.
 */
export function clampPaneLayout(layout, viewport, chrome = WORKSPACE_CHROME) {
    const next = normalizePaneLayout(layout);
    const width = finite(viewport?.width, Infinity);
    const height = finite(viewport?.height, Infinity);

    const centerWidth = () => width - paneExtent(next, "hierarchy", chrome) - paneExtent(next, "inspector", chrome) - 2 * chrome.splitter;
    for (const id of ["inspector", "hierarchy"]) {
        if (centerWidth() >= CENTER_MIN.width || next.panes[id].collapsed) continue;
        const deficit = CENTER_MIN.width - centerWidth();
        next.panes[id].size = clampSize(id, next.panes[id].size - deficit);
    }
    for (const id of ["inspector", "hierarchy"]) {
        if (centerWidth() >= CENTER_MIN.width) break;
        next.panes[id].collapsed = true;
    }

    const centerHeight = () => height - chrome.topBar - chrome.toolbar - chrome.splitter - paneExtent(next, "assets", chrome);
    if (centerHeight() < CENTER_MIN.height && !next.panes.assets.collapsed) {
        const deficit = CENTER_MIN.height - centerHeight();
        next.panes.assets.size = clampSize("assets", next.panes.assets.size - deficit);
    }
    if (centerHeight() < CENTER_MIN.height) next.panes.assets.collapsed = true;
    return next;
}

export function resizePane(layout, id, size, viewport = null, chrome = WORKSPACE_CHROME) {
    if (!PANE_IDS.includes(id)) return normalizePaneLayout(layout);
    const next = normalizePaneLayout(layout);
    next.panes[id] = { size: clampSize(id, size), collapsed: false };
    return viewport ? clampPaneLayout(next, viewport, chrome) : next;
}

/** Keyboard resize: ±8 px, ±32 px with `large`. Negative direction shrinks. */
export function stepPaneSize(layout, id, direction, { large = false, viewport = null } = {}) {
    const step = (large ? PANE_STEP.large : PANE_STEP.small) * (direction < 0 ? -1 : 1);
    return resizePane(layout, id, normalizePaneLayout(layout).panes[id].size + step, viewport);
}

export function togglePaneCollapsed(layout, id, collapsed = undefined) {
    if (!PANE_IDS.includes(id)) return normalizePaneLayout(layout);
    const next = normalizePaneLayout(layout);
    next.panes[id].collapsed = collapsed === undefined ? !next.panes[id].collapsed : collapsed === true;
    return next;
}

export function resetPane(layout, id) {
    if (!PANE_IDS.includes(id)) return normalizePaneLayout(layout);
    const next = normalizePaneLayout(layout);
    next.panes[id] = { size: PANE_LIMITS[id].default, collapsed: false };
    return next;
}

/** Viewport-relative rectangle of the scene pane (below the toolbar). */
export function centerRect(layout, viewport, chrome = WORKSPACE_CHROME) {
    const left = paneExtent(layout, "hierarchy", chrome) + chrome.splitter;
    const top = chrome.topBar + chrome.toolbar;
    const width = finite(viewport?.width, 0) - left - paneExtent(layout, "inspector", chrome) - chrome.splitter;
    const height = finite(viewport?.height, 0) - top - chrome.splitter - paneExtent(layout, "assets", chrome);
    return { top, left, width: Math.max(0, width), height: Math.max(0, height) };
}

/** CSS grid templates for the workspace: 5 columns (pane, splitter, center, splitter, pane) and 4 rows. */
export function paneGridTemplate(layout, chrome = WORKSPACE_CHROME, { panesHidden = false } = {}) {
    if (panesHidden) {
        return { columns: "minmax(0, 1fr)", rows: `${chrome.topBar}px minmax(0, 1fr)` };
    }
    return {
        columns: `${paneExtent(layout, "hierarchy", chrome)}px ${chrome.splitter}px minmax(0, 1fr) ${chrome.splitter}px ${paneExtent(layout, "inspector", chrome)}px`,
        rows: `${chrome.topBar}px minmax(0, 1fr) ${chrome.splitter}px ${paneExtent(layout, "assets", chrome)}px`,
    };
}

export function splitterAria(layout, id) {
    const pane = normalizePaneLayout(layout).panes[id];
    const limits = PANE_LIMITS[id];
    return {
        orientation: limits.axis === "x" ? "vertical" : "horizontal",
        valuenow: pane.collapsed ? 0 : pane.size,
        valuemin: limits.min,
        valuemax: limits.max,
    };
}

export function serializePaneLayout(layout) {
    const normalized = normalizePaneLayout(layout);
    return { version: PANE_LAYOUT_VERSION, panes: normalized.panes };
}

export function parsePaneLayout(raw) {
    if (raw && typeof raw === "object" && raw.version !== undefined && raw.version !== PANE_LAYOUT_VERSION) {
        return createDefaultPaneLayout();
    }
    return normalizePaneLayout(raw);
}

export function paneLayoutsEqual(left, right) {
    return JSON.stringify(serializePaneLayout(left)) === JSON.stringify(serializePaneLayout(right));
}
