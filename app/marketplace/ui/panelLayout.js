/**
 * Panel layout for the Marketplace workspace. Discover sizes the filters and
 * release-detail columns around a flexible results region. Publish sizes the
 * left column and the drafts row around a flexible catalog and editor.
 * Pure: no React or DOM. Sizes are CSS pixels. There is no collapsed state.
 */

export const PANEL_LAYOUT_VERSION = 1;

export const SPLITTER_SIZE = 6;

export const PANEL_STEP = Object.freeze({ small: 8, large: 32 });

export const DISCOVER_RESULTS_MIN = 320;

export const DISCOVER_LIMITS = Object.freeze({
    filters: Object.freeze({ default: 224, min: 180, max: 420, axis: "x" }),
    detail: Object.freeze({ default: 390, min: 320, max: 640, axis: "x" }),
});

export const PUBLISH_FLEX_MIN = Object.freeze({ inspector: 420, catalog: 180 });

export const PUBLISH_LIMITS = Object.freeze({
    column: Object.freeze({ default: 392, min: 280, max: 640, axis: "x" }),
    drafts: Object.freeze({ default: 220, min: 160, max: 520, axis: "y" }),
});

const SURFACES = Object.freeze({
    discover: DISCOVER_LIMITS,
    publish: PUBLISH_LIMITS,
});

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** A missing or non-positive container axis means "not measured yet". */
function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : Infinity;
}

function clampSize(limits, size) {
    return Math.round(Math.min(limits.max, Math.max(limits.min, finite(size, limits.default))));
}

function blankSurface(limits) {
    const surface = {};
    for (const id of Object.keys(limits)) surface[id] = { size: limits[id].default };
    return surface;
}

export function createDefaultPanelLayout() {
    return {
        version: PANEL_LAYOUT_VERSION,
        discover: blankSurface(DISCOVER_LIMITS),
        publish: blankSurface(PUBLISH_LIMITS),
    };
}

/** Tolerant normalization of stored or partial layouts. Unknown ids are dropped. */
export function normalizePanelLayout(raw) {
    const layout = createDefaultPanelLayout();
    const source = raw && typeof raw === "object" ? raw : {};
    for (const [surface, limits] of Object.entries(SURFACES)) {
        const panes = source[surface];
        if (!panes || typeof panes !== "object") continue;
        for (const id of Object.keys(limits)) {
            const pane = panes[id];
            if (!pane || typeof pane !== "object") continue;
            layout[surface][id] = { size: clampSize(limits[id], pane.size) };
        }
    }
    return layout;
}

function limitsFor(surface, id) {
    return SURFACES[surface]?.[id] ?? null;
}

function shrink(pane, limits, deficit) {
    pane.size = clampSize(limits, pane.size - deficit);
}

/**
 * Shrink sized panes so the flexible region stays at its minimum.
 * Discover gives up the detail column first, then the filters column.
 * Publish gives up the left column, then the drafts row. Panes stop at
 * their minimums; nothing collapses.
 * `mode` is `wide`, `detail-only`, or `stacked`. Stacked mode keeps the
 * stored sizes for when the wide layout returns.
 */
export function clampPanelLayout(layout, surface, container, mode = "wide") {
    const next = normalizePanelLayout(layout);
    if (mode === "stacked" || (surface !== "discover" && surface !== "publish")) return next;
    const width = positive(container?.width);
    const height = positive(container?.height);

    if (surface === "discover") {
        const filters = next.discover.filters;
        const detail = next.discover.detail;
        const resultsWidth = () => (mode === "detail-only"
            ? width - detail.size - SPLITTER_SIZE
            : width - filters.size - detail.size - 2 * SPLITTER_SIZE);
        if (resultsWidth() < DISCOVER_RESULTS_MIN) {
            shrink(detail, DISCOVER_LIMITS.detail, DISCOVER_RESULTS_MIN - resultsWidth());
        }
        if (mode !== "detail-only" && resultsWidth() < DISCOVER_RESULTS_MIN) {
            shrink(filters, DISCOVER_LIMITS.filters, DISCOVER_RESULTS_MIN - resultsWidth());
        }
        return next;
    }

    const column = next.publish.column;
    const drafts = next.publish.drafts;
    const inspectorWidth = () => width - column.size - SPLITTER_SIZE;
    if (inspectorWidth() < PUBLISH_FLEX_MIN.inspector) {
        shrink(column, PUBLISH_LIMITS.column, PUBLISH_FLEX_MIN.inspector - inspectorWidth());
    }
    const catalogHeight = () => height - drafts.size - SPLITTER_SIZE;
    if (catalogHeight() < PUBLISH_FLEX_MIN.catalog) {
        shrink(drafts, PUBLISH_LIMITS.drafts, PUBLISH_FLEX_MIN.catalog - catalogHeight());
    }
    return next;
}

export function resizePanel(layout, surface, id, size, container = null, mode = "wide") {
    const limits = limitsFor(surface, id);
    if (!limits) return normalizePanelLayout(layout);
    const next = normalizePanelLayout(layout);
    next[surface][id] = { size: clampSize(limits, size) };
    return container ? clampPanelLayout(next, surface, container, mode) : next;
}

/** Keyboard resize: ±8 px, ±32 px with `large`. Negative direction shrinks. */
export function stepPanelSize(layout, surface, id, direction, { large = false, container = null, mode = "wide" } = {}) {
    const limits = limitsFor(surface, id);
    if (!limits) return normalizePanelLayout(layout);
    const step = (large ? PANEL_STEP.large : PANEL_STEP.small) * (direction < 0 ? -1 : 1);
    const size = normalizePanelLayout(layout)[surface][id].size + step;
    return resizePanel(layout, surface, id, size, container, mode);
}

export function resetPanel(layout, surface, id) {
    const limits = limitsFor(surface, id);
    if (!limits) return normalizePanelLayout(layout);
    const next = normalizePanelLayout(layout);
    next[surface][id] = { size: limits.default };
    return next;
}

export function discoverGridTemplate(layout, mode = "wide") {
    const normalized = normalizePanelLayout(layout);
    if (mode === "detail-only") {
        return { columns: `minmax(0, 1fr) ${SPLITTER_SIZE}px ${normalized.discover.detail.size}px` };
    }
    if (mode !== "wide") return null;
    const { filters, detail } = normalized.discover;
    return {
        columns: `${filters.size}px ${SPLITTER_SIZE}px minmax(0, 1fr) ${SPLITTER_SIZE}px ${detail.size}px`,
    };
}

export function publishGridTemplate(layout) {
    const normalized = normalizePanelLayout(layout);
    return {
        columns: `${normalized.publish.column.size}px ${SPLITTER_SIZE}px minmax(0, 1fr)`,
        rows: `minmax(0, 1fr) ${SPLITTER_SIZE}px ${normalized.publish.drafts.size}px`,
    };
}

export function splitterAria(layout, surface, id) {
    const limits = limitsFor(surface, id);
    if (!limits) return null;
    const pane = normalizePanelLayout(layout)[surface][id];
    return {
        orientation: limits.axis === "x" ? "vertical" : "horizontal",
        valuenow: pane.size,
        valuemin: limits.min,
        valuemax: limits.max,
    };
}

export function serializePanelLayout(layout) {
    const normalized = normalizePanelLayout(layout);
    return {
        version: PANEL_LAYOUT_VERSION,
        discover: normalized.discover,
        publish: normalized.publish,
    };
}

export function parsePanelLayout(raw) {
    if (raw && typeof raw === "object" && raw.version !== undefined && raw.version !== PANEL_LAYOUT_VERSION) {
        return createDefaultPanelLayout();
    }
    return normalizePanelLayout(raw);
}

export function panelLayoutsEqual(left, right) {
    return JSON.stringify(serializePanelLayout(left)) === JSON.stringify(serializePanelLayout(right));
}
