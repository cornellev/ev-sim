import assert from "node:assert/strict";
import test from "node:test";

import {
    CENTER_MIN,
    PANE_LIMITS,
    WORKSPACE_CHROME,
    centerRect,
    clampPaneLayout,
    createDefaultPaneLayout,
    normalizePaneLayout,
    paneGridTemplate,
    paneLayoutsEqual,
    parsePaneLayout,
    resetPane,
    resizePane,
    serializePaneLayout,
    splitterAria,
    stepPaneSize,
    togglePaneCollapsed,
} from "../app/3d/editor/workspace/paneLayout.js";
import { normalizeViewportRect, resolveRenderViewport, viewportRectsEqual } from "../app/3d/viewportRect.js";

const HD = { width: 1280, height: 720 };

test("ED-03 the default pane layout leaves a usable scene pane at 1280x720", () => {
    const layout = createDefaultPaneLayout();
    assert.deepEqual(Object.fromEntries(Object.entries(layout.panes).map(([id, pane]) => [id, pane.size])), { hierarchy: 232, inspector: 304, assets: 208 });
    const rect = centerRect(layout, HD);
    assert.equal(rect.left, 232 + WORKSPACE_CHROME.splitter);
    assert.equal(rect.top, WORKSPACE_CHROME.topBar + WORKSPACE_CHROME.toolbar);
    assert.ok(rect.width >= CENTER_MIN.width, `center width ${rect.width}`);
    assert.ok(rect.height >= CENTER_MIN.height, `center height ${rect.height}`);
    assert.equal(paneLayoutsEqual(clampPaneLayout(layout, HD), layout), true, "no clamping needed at 1280x720");
    const template = paneGridTemplate(layout);
    assert.equal(template.columns, "232px 6px minmax(0, 1fr) 6px 304px");
    assert.equal(template.rows, "40px minmax(0, 1fr) 6px 208px");
    assert.deepEqual(paneGridTemplate(layout, WORKSPACE_CHROME, { panesHidden: true }), { columns: "minmax(0, 1fr)", rows: "40px minmax(0, 1fr)" });
});

test("ED-03 clamping shrinks the inspector, then the hierarchy, then the asset pane before collapsing them", () => {
    const layout = createDefaultPaneLayout();
    const narrow = clampPaneLayout(layout, { width: 1024, height: 640 });
    assert.equal(narrow.panes.inspector.collapsed, false);
    assert.equal(narrow.panes.inspector.size, 304 - (CENTER_MIN.width - (1024 - 232 - 304 - 12)), "the inspector gives way first, by exactly the deficit");
    assert.equal(narrow.panes.hierarchy.size, 232, "the hierarchy keeps its size while the inspector can absorb the deficit");
    assert.ok(centerRect(narrow, { width: 1024, height: 640 }).width >= CENTER_MIN.width);
    assert.equal(narrow.panes.assets.size, 208, "640 px tall leaves the scene above its minimum height");
    const short = clampPaneLayout(layout, { width: 1280, height: 480 });
    assert.equal(short.panes.assets.size, 208 - (CENTER_MIN.height - (480 - 40 - 36 - 6 - 208)), "the asset pane shrinks by exactly the height deficit");
    assert.equal(short.panes.assets.collapsed, false);
    assert.ok(centerRect(short, { width: 1280, height: 480 }).height >= CENTER_MIN.height);

    const tiny = clampPaneLayout(layout, { width: 700, height: 400 });
    assert.equal(tiny.panes.inspector.collapsed, true, "collapsed when minimums are not enough");
    assert.equal(tiny.panes.hierarchy.collapsed, false);
    assert.equal(tiny.panes.hierarchy.size, PANE_LIMITS.hierarchy.min);
    assert.ok(centerRect(tiny, { width: 700, height: 400 }).width >= CENTER_MIN.width);
    assert.equal(tiny.panes.assets.collapsed, true);
    assert.ok(centerRect(tiny, { width: 700, height: 400 }).height >= CENTER_MIN.height);
});

test("ED-03 resize, step, toggle, and reset honor limits and viewport clamps", () => {
    const layout = createDefaultPaneLayout();
    assert.equal(resizePane(layout, "hierarchy", 5000).panes.hierarchy.size, PANE_LIMITS.hierarchy.max);
    assert.equal(resizePane(layout, "hierarchy", 5).panes.hierarchy.size, PANE_LIMITS.hierarchy.min);
    assert.equal(resizePane(layout, "hierarchy", 300.4).panes.hierarchy.size, 300);
    assert.equal(resizePane(layout, "hierarchy", 460, HD).panes.hierarchy.size, 460, "1280 - 460 - 304 - 12 stays above the center minimum");
    assert.equal(resizePane(layout, "inspector", 560, { width: 1000, height: 720 }).panes.inspector.size, PANE_LIMITS.inspector.min + (1000 - 232 - 240 - 12 - CENTER_MIN.width) , "clamped down to keep the center at its minimum");

    assert.equal(stepPaneSize(layout, "assets", 1).panes.assets.size, 216);
    assert.equal(stepPaneSize(layout, "assets", -1, { large: true }).panes.assets.size, 176);
    const collapsed = togglePaneCollapsed(layout, "inspector");
    assert.equal(collapsed.panes.inspector.collapsed, true);
    assert.equal(collapsed.panes.inspector.size, 304, "collapsing remembers the size");
    assert.equal(togglePaneCollapsed(collapsed, "inspector").panes.inspector.collapsed, false);
    assert.equal(togglePaneCollapsed(layout, "inspector", true).panes.inspector.collapsed, true);
    assert.equal(resizePane(collapsed, "inspector", 320).panes.inspector.collapsed, false, "resizing expands");
    assert.equal(paneGridTemplate(collapsed).columns, `232px 6px minmax(0, 1fr) 6px ${WORKSPACE_CHROME.rail}px`);
    assert.deepEqual(splitterAria(collapsed, "inspector"), { orientation: "vertical", valuenow: 0, valuemin: 240, valuemax: 560 });
    assert.deepEqual(splitterAria(layout, "assets"), { orientation: "horizontal", valuenow: 208, valuemin: 120, valuemax: 480 });
    assert.deepEqual(resetPane(resizePane(collapsed, "inspector", 320), "inspector").panes.inspector, { size: 304, collapsed: false });
    assert.equal(resizePane(layout, "nope", 10).panes.hierarchy.size, 232, "unknown panes are ignored");
});

test("ED-03 pane layouts serialize, tolerate junk, and reject other versions", () => {
    const layout = togglePaneCollapsed(resizePane(createDefaultPaneLayout(), "assets", 160), "hierarchy");
    const stored = JSON.parse(JSON.stringify(serializePaneLayout(layout)));
    assert.equal(stored.version, 1);
    assert.deepEqual(parsePaneLayout(stored), layout);
    assert.deepEqual(parsePaneLayout(null), createDefaultPaneLayout());
    assert.deepEqual(parsePaneLayout("garbage"), createDefaultPaneLayout());
    assert.deepEqual(parsePaneLayout({ version: 99, panes: stored.panes }), createDefaultPaneLayout(), "unknown versions fall back");
    const junk = normalizePaneLayout({ hierarchy: { size: "wide", collapsed: "yes" }, inspector: { size: 99999 }, bogus: { size: 1 } });
    assert.deepEqual(junk.panes.hierarchy, { size: 232, collapsed: false });
    assert.deepEqual(junk.panes.inspector, { size: 560, collapsed: false });
    assert.equal("bogus" in junk.panes, false);
});

test("ED-03 the render viewport prefers embedded, then workspace, then the window", () => {
    const win = { innerWidth: 1280, innerHeight: 720 };
    assert.deepEqual(resolveRenderViewport({ window: win }), { rect: { top: 0, left: 0, width: 1280, height: 720 }, source: "window" });
    assert.deepEqual(resolveRenderViewport({ workspace: { top: 76.4, left: 238, width: 731.6, height: 430 }, window: win }), { rect: { top: 76, left: 238, width: 732, height: 430 }, source: "workspace" });
    assert.deepEqual(resolveRenderViewport({ embedded: { top: 10, left: 20, width: 300, height: 200 }, workspace: { top: 0, left: 0, width: 900, height: 600 }, window: win }).source, "embedded");
    assert.equal(normalizeViewportRect(null), null);
    assert.deepEqual(normalizeViewportRect({ width: 0, height: 0 }), { top: 0, left: 0, width: 1, height: 1 });
    assert.equal(viewportRectsEqual({ top: 1, left: 2, width: 3, height: 4 }, { top: 1, left: 2, width: 3, height: 4 }), true);
    assert.equal(viewportRectsEqual({ top: 1, left: 2, width: 3, height: 4 }, null), false);
});
