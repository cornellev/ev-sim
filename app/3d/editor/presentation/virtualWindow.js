/**
 * Windowing math for long fixed-height lists (the hierarchy tree) and tree
 * keyboard navigation over flattened rows. Pure; no DOM.
 */

export const HIERARCHY_ROW_HEIGHT = 24;
export const CATALOG_ROW_HEIGHT = 64;
export const CATALOG_GRID_ITEM_HEIGHT = 96;
export const CATALOG_GRID_GAP = 6;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * @returns {{ start: number, end: number, offsetTop: number, totalHeight: number }} `end` is exclusive.
 */
export function computeWindow({ rowCount, rowHeight = HIERARCHY_ROW_HEIGHT, scrollTop = 0, viewportHeight = 0, overscan = 6 } = {}) {
    const count = Math.max(0, Math.floor(finite(rowCount)));
    const height = Math.max(1, finite(rowHeight, HIERARCHY_ROW_HEIGHT));
    const totalHeight = count * height;
    if (count === 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
    const view = Math.max(0, finite(viewportHeight));
    const top = Math.min(Math.max(0, finite(scrollTop)), Math.max(0, totalHeight - Math.max(height, view)));
    const visible = Math.max(1, Math.ceil(view / height));
    const first = Math.floor(top / height);
    const start = Math.max(0, first - Math.max(0, Math.floor(finite(overscan))));
    const end = Math.min(count, first + visible + Math.max(0, Math.floor(finite(overscan))) + 1);
    return { start, end, offsetTop: start * height, totalHeight };
}

/**
 * Window fixed-height items that may be arranged in multiple columns. The
 * returned start/end address items, while offsetTop/totalHeight address visual
 * rows. `rowGap` is included in the scroll pitch.
 */
export function computeItemWindow({
    itemCount,
    columns = 1,
    itemHeight = CATALOG_ROW_HEIGHT,
    rowGap = 0,
    scrollTop = 0,
    viewportHeight = 0,
    overscan = 6,
} = {}) {
    const count = Math.max(0, Math.floor(finite(itemCount)));
    const columnCount = Math.max(1, Math.floor(finite(columns, 1)));
    const height = Math.max(1, finite(itemHeight, CATALOG_ROW_HEIGHT));
    const gap = Math.max(0, finite(rowGap));
    const rowCount = Math.ceil(count / columnCount);
    const window = computeWindow({
        rowCount,
        rowHeight: height + gap,
        scrollTop,
        viewportHeight,
        overscan,
    });
    return {
        start: Math.min(count, window.start * columnCount),
        end: Math.min(count, window.end * columnCount),
        offsetTop: window.offsetTop,
        totalHeight: Math.max(0, window.totalHeight - (rowCount > 0 ? gap : 0)),
        columns: columnCount,
        itemHeight: height,
    };
}

/** Smallest scroll change that brings `index` fully into view. */
export function scrollTopToReveal({ index, rowHeight = HIERARCHY_ROW_HEIGHT, scrollTop = 0, viewportHeight = 0 } = {}) {
    const height = Math.max(1, finite(rowHeight, HIERARCHY_ROW_HEIGHT));
    const top = Math.max(0, finite(index)) * height;
    const bottom = top + height;
    const current = Math.max(0, finite(scrollTop));
    const view = Math.max(height, finite(viewportHeight));
    if (top < current) return top;
    if (bottom > current + view) return bottom - view;
    return current;
}

export function rowIndexAtOffset(offset, rowHeight = HIERARCHY_ROW_HEIGHT) {
    return Math.max(0, Math.floor(finite(offset) / Math.max(1, finite(rowHeight, HIERARCHY_ROW_HEIGHT))));
}

/** Index of the row's parent (the nearest earlier row one level shallower), or -1. */
export function parentRowIndex(rows, index) {
    const row = rows?.[index];
    if (!row || row.depth <= 0) return -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (rows[cursor].depth === row.depth - 1) return cursor;
    }
    return -1;
}

/**
 * Tree keyboard navigation over flattened rows.
 * @returns {{ index: number, toggle?: "expand"|"collapse" }}
 */
export function nextTreeIndex(rows, index, key) {
    const count = rows?.length ?? 0;
    const current = Math.min(Math.max(0, finite(index, 0)), Math.max(0, count - 1));
    if (count === 0) return { index: -1 };
    const row = rows[current];
    switch (key) {
        case "ArrowDown":
            return { index: Math.min(count - 1, current + 1) };
        case "ArrowUp":
            return { index: Math.max(0, current - 1) };
        case "Home":
            return { index: 0 };
        case "End":
            return { index: count - 1 };
        case "ArrowRight":
            if (row?.isGroup && row.hasChildren && !row.expanded) return { index: current, toggle: "expand" };
            if (row?.isGroup && row.expanded && row.hasChildren) return { index: Math.min(count - 1, current + 1) };
            return { index: current };
        case "ArrowLeft": {
            if (row?.isGroup && row.expanded && row.hasChildren) return { index: current, toggle: "collapse" };
            const parent = parentRowIndex(rows, current);
            return { index: parent >= 0 ? parent : current };
        }
        default:
            return { index: current };
    }
}

/** `aria-posinset` / `aria-setsize` per row from the visible rows. */
export function siblingPositions(rows) {
    const groups = new Map();
    for (const row of rows ?? []) {
        const key = row.record?.parentId ?? null;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row.id);
    }
    const positions = new Map();
    for (const ids of groups.values()) {
        ids.forEach((id, index) => positions.set(id, { posinset: index + 1, setsize: ids.length }));
    }
    return positions;
}
