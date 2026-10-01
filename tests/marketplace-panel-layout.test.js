import assert from "node:assert/strict";
import test from "node:test";

import {
    readMarketplacePanelLayout,
    writeMarketplacePanelLayout,
    MARKETPLACE_PANEL_LAYOUT_KEY,
} from "../app/marketplace/ui/marketplaceWorkspacePreferences.js";
import {
    DISCOVER_LIMITS,
    DISCOVER_RESULTS_MIN,
    PUBLISH_FLEX_MIN,
    PUBLISH_LIMITS,
    SPLITTER_SIZE,
    clampPanelLayout,
    createDefaultPanelLayout,
    discoverGridTemplate,
    normalizePanelLayout,
    panelLayoutsEqual,
    parsePanelLayout,
    publishGridTemplate,
    resetPanel,
    resizePanel,
    serializePanelLayout,
    splitterAria,
    stepPanelSize,
} from "../app/marketplace/ui/panelLayout.js";

const WIDE = { width: 1280, height: 680 };

test("marketplace panel defaults match the fixed Discover and Publish tracks", () => {
    const layout = createDefaultPanelLayout();
    assert.equal(layout.version, 1);
    assert.equal(layout.discover.filters.size, 224);
    assert.equal(layout.discover.detail.size, 390);
    assert.equal(layout.publish.column.size, 392);
    assert.equal(layout.publish.drafts.size, 220);
    assert.equal(panelLayoutsEqual(clampPanelLayout(layout, "discover", WIDE, "wide"), layout), true);
    assert.equal(panelLayoutsEqual(clampPanelLayout(layout, "publish", WIDE, "wide"), layout), true);
    assert.equal(discoverGridTemplate(layout, "wide").columns, "224px 6px minmax(0, 1fr) 6px 390px");
    assert.equal(discoverGridTemplate(layout, "detail-only").columns, "minmax(0, 1fr) 6px 390px");
    assert.equal(discoverGridTemplate(layout, "stacked"), null);
    assert.deepEqual(publishGridTemplate(layout), {
        columns: "392px 6px minmax(0, 1fr)",
        rows: "minmax(0, 1fr) 6px 220px",
    });
    assert.deepEqual(splitterAria(layout, "discover", "filters"), { orientation: "vertical", valuenow: 224, valuemin: 180, valuemax: 420 });
    assert.deepEqual(splitterAria(layout, "publish", "drafts"), { orientation: "horizontal", valuenow: 220, valuemin: 160, valuemax: 520 });
    assert.equal(splitterAria(layout, "discover", "missing"), null);
});

test("marketplace panel clamping shrinks detail before filters, and the publish column before drafts", () => {
    const layout = createDefaultPanelLayout();
    const detailFirst = clampPanelLayout(layout, "discover", { width: 900, height: 640 }, "wide");
    assert.equal(detailFirst.discover.detail.size, 390 - (DISCOVER_RESULTS_MIN - (900 - 224 - 390 - 2 * SPLITTER_SIZE)));
    assert.equal(detailFirst.discover.filters.size, 224, "filters stay while detail can absorb the deficit");
    assert.equal(detailFirst.publish.column.size, 392, "discover clamping leaves publish alone");

    const both = clampPanelLayout(layout, "discover", { width: 860, height: 640 }, "wide");
    assert.equal(both.discover.detail.size, DISCOVER_LIMITS.detail.min);
    assert.equal(both.discover.filters.size, 224 - (DISCOVER_RESULTS_MIN - (860 - 224 - DISCOVER_LIMITS.detail.min - 2 * SPLITTER_SIZE)));

    const mid = clampPanelLayout(resizePanel(layout, "discover", "filters", 400), "discover", { width: 700, height: 640 }, "detail-only");
    assert.equal(mid.discover.filters.size, 400, "the filters band is not a column in detail-only mode");
    assert.equal(mid.discover.detail.size, 390 - (DISCOVER_RESULTS_MIN - (700 - 390 - SPLITTER_SIZE)));

    const column = clampPanelLayout(layout, "publish", { width: 800, height: 680 }, "wide");
    assert.equal(column.publish.column.size, 392 - (PUBLISH_FLEX_MIN.inspector - (800 - 392 - SPLITTER_SIZE)));
    assert.equal(column.publish.drafts.size, 220);
    const drafts = clampPanelLayout(layout, "publish", { width: 1280, height: 360 }, "wide");
    assert.equal(drafts.publish.drafts.size, 220 - (PUBLISH_FLEX_MIN.catalog - (360 - 220 - SPLITTER_SIZE)));
    assert.equal(drafts.publish.column.size, 392);
    const floor = clampPanelLayout(layout, "publish", { width: 600, height: 300 }, "wide");
    assert.equal(floor.publish.column.size, PUBLISH_LIMITS.column.min);
    assert.equal(floor.publish.drafts.size, PUBLISH_LIMITS.drafts.min);

    assert.equal(panelLayoutsEqual(clampPanelLayout(layout, "discover", { width: 0, height: 0 }, "wide"), layout), true, "an unmeasured container does not shrink stored sizes");
    assert.equal(panelLayoutsEqual(clampPanelLayout(resizePanel(layout, "discover", "detail", 500), "discover", { width: 640, height: 400 }, "stacked"), resizePanel(layout, "discover", "detail", 500)), true);
});

test("marketplace panel resize, step, and reset honor limits without collapsing", () => {
    const layout = createDefaultPanelLayout();
    assert.equal(resizePanel(layout, "discover", "filters", 5000).discover.filters.size, DISCOVER_LIMITS.filters.max);
    assert.equal(resizePanel(layout, "discover", "detail", 5).discover.detail.size, DISCOVER_LIMITS.detail.min);
    assert.equal(resizePanel(layout, "publish", "column", 300.6).publish.column.size, 301);
    const fitted = resizePanel(layout, "discover", "filters", 400, { width: 900, height: 640 }, "wide");
    assert.equal(fitted.discover.detail.size, DISCOVER_LIMITS.detail.min, "detail gives way before filters");
    assert.equal(fitted.discover.filters.size, 248, "filters then shrink until results stay at their minimum");
    assert.equal(stepPanelSize(layout, "discover", "filters", 1).discover.filters.size, 232);
    assert.equal(stepPanelSize(layout, "publish", "drafts", -1, { large: true }).publish.drafts.size, 188);
    assert.equal(resizePanel(layout, "discover", "nope", 10).discover.filters.size, 224);
    assert.equal(stepPanelSize(layout, "publish", "nope", 1).publish.column.size, 392);
    const resized = resizePanel(resizePanel(layout, "discover", "filters", 300), "publish", "drafts", 280);
    assert.deepEqual(resetPanel(resized, "discover", "filters").discover.filters, { size: 224 });
    assert.equal(resetPanel(resized, "discover", "filters").publish.drafts.size, 280, "reset touches one pane");
    assert.equal(resetPanel(layout, "publish", "missing").publish.column.size, 392);
});

test("marketplace panel layouts serialize, tolerate junk, and reject other versions", () => {
    const layout = resizePanel(resizePanel(createDefaultPanelLayout(), "discover", "detail", 480), "publish", "column", 360);
    const stored = JSON.parse(JSON.stringify(serializePanelLayout(layout)));
    assert.equal(stored.version, 1);
    assert.deepEqual(parsePanelLayout(stored), layout);
    assert.deepEqual(parsePanelLayout(null), createDefaultPanelLayout());
    assert.deepEqual(parsePanelLayout("garbage"), createDefaultPanelLayout());
    assert.deepEqual(parsePanelLayout({ version: 99, discover: stored.discover }), createDefaultPanelLayout());
    const partial = normalizePanelLayout({ discover: { filters: { size: 300 }, bogus: { size: 1 } }, publish: { drafts: { size: "tall" } } });
    assert.deepEqual(partial.discover.filters, { size: 300 });
    assert.deepEqual(partial.discover.detail, { size: 390 });
    assert.equal("bogus" in partial.discover, false);
    assert.deepEqual(partial.publish.drafts, { size: 220 });
    assert.deepEqual(partial.publish.column, { size: 392 });
});

test("marketplace panel preferences persist one document and ignore storage failures", () => {
    const memory = new Map();
    const storage = {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => memory.set(key, value),
    };
    assert.equal(readMarketplacePanelLayout(storage), null);
    const layout = resizePanel(createDefaultPanelLayout(), "discover", "filters", 232);
    writeMarketplacePanelLayout(layout, storage);
    assert.equal(memory.has(MARKETPLACE_PANEL_LAYOUT_KEY), true);
    assert.deepEqual(parsePanelLayout(readMarketplacePanelLayout(storage)), layout);
    assert.equal(readMarketplacePanelLayout({ getItem: () => { throw new Error("blocked"); } }), null);
    assert.doesNotThrow(() => writeMarketplacePanelLayout(layout, { setItem: () => { throw new Error("blocked"); } }));
    assert.equal(readMarketplacePanelLayout({ getItem: () => "not-json" }), null);
});
