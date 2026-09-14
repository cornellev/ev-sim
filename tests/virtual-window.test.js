import assert from "node:assert/strict";
import test from "node:test";

import {
    CATALOG_GRID_GAP,
    CATALOG_GRID_ITEM_HEIGHT,
    CATALOG_ROW_HEIGHT,
    HIERARCHY_ROW_HEIGHT,
    computeItemWindow,
    computeWindow,
    nextTreeIndex,
    parentRowIndex,
    rowIndexAtOffset,
    scrollTopToReveal,
    siblingPositions,
} from "../app/3d/editor/presentation/virtualWindow.js";

function rows() {
    // depth / group layout: G0 > [a, G1 > [b, c]], d
    return [
        { id: "g0", depth: 0, isGroup: true, expanded: true, hasChildren: true, record: { parentId: null } },
        { id: "a", depth: 1, isGroup: false, expanded: false, hasChildren: false, record: { parentId: "g0" } },
        { id: "g1", depth: 1, isGroup: true, expanded: true, hasChildren: true, record: { parentId: "g0" } },
        { id: "b", depth: 2, isGroup: false, expanded: false, hasChildren: false, record: { parentId: "g1" } },
        { id: "c", depth: 2, isGroup: false, expanded: false, hasChildren: false, record: { parentId: "g1" } },
        { id: "d", depth: 0, isGroup: false, expanded: false, hasChildren: false, record: { parentId: null } },
    ];
}

test("ED-03 the row window covers the viewport plus overscan and never exceeds the row count", () => {
    const empty = computeWindow({ rowCount: 0, viewportHeight: 400 });
    assert.deepEqual(empty, { start: 0, end: 0, offsetTop: 0, totalHeight: 0 });

    const top = computeWindow({ rowCount: 10000, rowHeight: 24, scrollTop: 0, viewportHeight: 480, overscan: 6 });
    assert.equal(top.start, 0);
    assert.equal(top.end, 20 + 6 + 1);
    assert.equal(top.offsetTop, 0);
    assert.equal(top.totalHeight, 240000);

    const middle = computeWindow({ rowCount: 10000, rowHeight: 24, scrollTop: 24 * 5000 + 7, viewportHeight: 480, overscan: 6 });
    assert.equal(middle.start, 5000 - 6);
    assert.equal(middle.offsetTop, (5000 - 6) * 24);
    assert.equal(middle.end, 5000 + 20 + 6 + 1);
    assert.ok(middle.end - middle.start < 40, "a 10k-row tree renders a few dozen rows");

    const bottom = computeWindow({ rowCount: 100, rowHeight: 24, scrollTop: 99999, viewportHeight: 480, overscan: 6 });
    assert.equal(bottom.end, 100);
    assert.ok(bottom.start <= 99 - 20);
    assert.equal(computeWindow({ rowCount: 5, rowHeight: 24, scrollTop: 0, viewportHeight: 480 }).end, 5);
    assert.equal(computeWindow({ rowCount: 3, rowHeight: 0, scrollTop: -10, viewportHeight: -5 }).end, 3, "degenerate inputs are clamped");
});

test("ED-09 a 10k catalog window stays under 40 rows", () => {
    const middle = computeWindow({
        rowCount: 10000,
        rowHeight: CATALOG_ROW_HEIGHT,
        scrollTop: CATALOG_ROW_HEIGHT * 5000,
        viewportHeight: 480,
        overscan: 6,
    });
    assert.ok(middle.end - middle.start < 40, "a 10k catalog renders a few dozen rows");
    assert.equal(CATALOG_ROW_HEIGHT, 64);
});

test("ED-09 catalog grid windows visual rows and reaches every item at the bottom", () => {
    const top = computeItemWindow({
        itemCount: 800,
        columns: 7,
        itemHeight: CATALOG_GRID_ITEM_HEIGHT,
        rowGap: CATALOG_GRID_GAP,
        viewportHeight: 240,
        overscan: 2,
    });
    assert.equal(top.start, 0);
    assert.equal(top.columns, 7);
    assert.equal(top.end % 7, 0, "whole visual rows are mounted");
    assert.equal(top.itemHeight, 96);
    assert.ok(top.end < 80, "a small bounded set of grid items is mounted");

    const bottom = computeItemWindow({
        itemCount: 800,
        columns: 7,
        itemHeight: CATALOG_GRID_ITEM_HEIGHT,
        rowGap: CATALOG_GRID_GAP,
        scrollTop: Number.MAX_SAFE_INTEGER,
        viewportHeight: 240,
        overscan: 2,
    });
    assert.equal(bottom.end, 800);
    assert.ok(bottom.start <= 799);
    assert.equal(bottom.totalHeight, Math.ceil(800 / 7) * (CATALOG_GRID_ITEM_HEIGHT + CATALOG_GRID_GAP) - CATALOG_GRID_GAP);

    assert.deepEqual(computeItemWindow({ itemCount: 0, columns: 0 }), {
        start: 0,
        end: 0,
        offsetTop: 0,
        totalHeight: 0,
        columns: 1,
        itemHeight: CATALOG_ROW_HEIGHT,
    });
});

test("ED-03 revealing a row scrolls the minimum distance and offsets map back to rows", () => {
    assert.equal(scrollTopToReveal({ index: 3, rowHeight: 24, scrollTop: 0, viewportHeight: 480 }), 0, "already visible");
    assert.equal(scrollTopToReveal({ index: 100, rowHeight: 24, scrollTop: 0, viewportHeight: 480 }), 100 * 24 + 24 - 480, "scroll down until the row's bottom is visible");
    assert.equal(scrollTopToReveal({ index: 2, rowHeight: 24, scrollTop: 240, viewportHeight: 480 }), 48, "scroll up to the row's top");
    assert.equal(rowIndexAtOffset(0), 0);
    assert.equal(rowIndexAtOffset(HIERARCHY_ROW_HEIGHT * 3 + 1), 3);
    assert.equal(rowIndexAtOffset(-5), 0);
});

test("ED-03 tree keyboard navigation moves, expands, collapses, and jumps to parents", () => {
    const list = rows();
    assert.deepEqual(nextTreeIndex(list, 0, "ArrowDown"), { index: 1 });
    assert.deepEqual(nextTreeIndex(list, 5, "ArrowDown"), { index: 5 });
    assert.deepEqual(nextTreeIndex(list, 0, "ArrowUp"), { index: 0 });
    assert.deepEqual(nextTreeIndex(list, 3, "Home"), { index: 0 });
    assert.deepEqual(nextTreeIndex(list, 3, "End"), { index: 5 });
    assert.deepEqual(nextTreeIndex(list, 2, "ArrowRight"), { index: 3 }, "an expanded group moves into its first child");
    assert.deepEqual(nextTreeIndex(list, 2, "ArrowLeft"), { index: 2, toggle: "collapse" });
    const collapsed = list.map((row) => (row.id === "g1" ? { ...row, expanded: false } : row));
    assert.deepEqual(nextTreeIndex(collapsed, 2, "ArrowRight"), { index: 2, toggle: "expand" });
    assert.deepEqual(nextTreeIndex(list, 4, "ArrowLeft"), { index: 2 }, "a leaf jumps to its parent");
    assert.deepEqual(nextTreeIndex(list, 5, "ArrowLeft"), { index: 5 }, "roots stay put");
    assert.deepEqual(nextTreeIndex(list, 1, "ArrowRight"), { index: 1 }, "leaves ignore ArrowRight");
    assert.deepEqual(nextTreeIndex(list, 99, "ArrowUp"), { index: 4 }, "out-of-range indices clamp");
    assert.deepEqual(nextTreeIndex([], 0, "ArrowDown"), { index: -1 });
    assert.equal(parentRowIndex(list, 3), 2);
    assert.equal(parentRowIndex(list, 1), 0);
    assert.equal(parentRowIndex(list, 0), -1);
});

test("ED-03 sibling positions give aria-posinset and aria-setsize per visible level", () => {
    const positions = siblingPositions(rows());
    assert.deepEqual(positions.get("g0"), { posinset: 1, setsize: 2 });
    assert.deepEqual(positions.get("d"), { posinset: 2, setsize: 2 });
    assert.deepEqual(positions.get("a"), { posinset: 1, setsize: 2 });
    assert.deepEqual(positions.get("c"), { posinset: 2, setsize: 2 });
});
