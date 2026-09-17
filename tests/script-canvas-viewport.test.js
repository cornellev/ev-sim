import assert from "node:assert/strict";
import test from "node:test";

import {
    CANVAS_MAX_SCALE,
    CANVAS_MIN_SCALE,
    DEFAULT_CANVAS_VIEWPORT,
    canvasWorldTransform,
    clampScale,
    fitViewportToWorldPoints,
    canStartEmptyCanvasPan,
    isCanvasChromeTarget,
    isEditableTarget,
    normalizeCanvasViewport,
    panViewport,
    screenToWorld,
    wheelZoomFactor,
    worldToScreen,
    zoomViewportAt,
} from "../app/scripting/canvas/CanvasViewport.js";
import {
    getFallbackNodePosition,
    normalizeOutputNodePosition,
    normalizeRestoredPosition,
} from "../app/scripting/canvas/canvasPositions.js";

test("screen and world round-trip at identity and translated cameras", () => {
    const origin = { x: 12, y: 8 };
    const screen = { x: 212, y: 108 };
    const identity = screenToWorld(screen, DEFAULT_CANVAS_VIEWPORT, origin);
    assert.deepEqual(worldToScreen(identity, DEFAULT_CANVAS_VIEWPORT, origin), screen);

    const camera = { x: 40, y: -10, scale: 2 };
    const world = screenToWorld(screen, camera, origin);
    assert.deepEqual(worldToScreen(world, camera, origin), screen);
});

test("zoomViewportAt keeps the world point under the cursor fixed", () => {
    const origin = { x: 0, y: 0 };
    const cursor = { x: 400, y: 240 };
    const before = { x: 80, y: 20, scale: 1 };
    const worldBefore = screenToWorld(cursor, before, origin);
    const after = zoomViewportAt(before, cursor, 2, origin);
    const worldAfter = screenToWorld(cursor, after, origin);

    assert.equal(after.scale, 2);
    assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-9);
    assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-9);
});

test("clampScale and normalizeCanvasViewport reject garbage", () => {
    assert.equal(clampScale(0.01), CANVAS_MIN_SCALE);
    assert.equal(clampScale(99), CANVAS_MAX_SCALE);
    assert.deepEqual(normalizeCanvasViewport(null), { ...DEFAULT_CANVAS_VIEWPORT });
    assert.deepEqual(normalizeCanvasViewport({ x: "nope", y: Number.NaN, scale: Number.POSITIVE_INFINITY }), {
        ...DEFAULT_CANVAS_VIEWPORT,
    });
    assert.equal(normalizeCanvasViewport({ x: 4, y: 5, scale: 99 }).scale, CANVAS_MAX_SCALE);
});

test("fitViewportToWorldPoints frames two points inside the padded canvas", () => {
    const fitted = fitViewportToWorldPoints(
        [{ x: 0, y: 0 }, { x: 400, y: 200 }],
        { width: 800, height: 600 },
        { padding: 80 },
    );

    const topLeft = worldToScreen({ x: 0, y: 0 }, fitted, { x: 0, y: 0 });
    const bottomRight = worldToScreen({ x: 400, y: 200 }, fitted, { x: 0, y: 0 });

    assert.ok(fitted.scale > 0);
    assert.ok(fitted.scale <= CANVAS_MAX_SCALE);
    assert.ok(topLeft.x >= 80 - 1e-6);
    assert.ok(topLeft.y >= 80 - 1e-6);
    assert.ok(bottomRight.x <= 800 - 80 + 1e-6);
    assert.ok(bottomRight.y <= 600 - 80 + 1e-6);
    assert.deepEqual(fitViewportToWorldPoints([], { width: 800, height: 600 }), { ...DEFAULT_CANVAS_VIEWPORT });
});

test("pan, wheel factor, and CSS transform follow the camera contract", () => {
    const panned = panViewport({ x: 10, y: 20, scale: 1.5 }, 5, -8);
    assert.deepEqual(panned, { x: 15, y: 12, scale: 1.5 });
    assert.equal(canvasWorldTransform(panned), "translate(15px, 12px) scale(1.5)");
    assert.ok(wheelZoomFactor(100) < 1);
    assert.ok(wheelZoomFactor(-100) > 1);
});

test("normalizeRestoredPosition no longer clamps to the window", () => {
    assert.deepEqual(normalizeRestoredPosition({ x: 5000, y: -40 }), { x: 5000, y: -40 });
    assert.deepEqual(normalizeRestoredPosition({ x: "bad", y: 1 }, 2), getFallbackNodePosition(2));
    assert.deepEqual(normalizeOutputNodePosition({ x: 12, y: 34 }), { x: 12, y: 34 });
    assert.deepEqual(normalizeOutputNodePosition(null), { x: 100, y: 100 });
});

test("editable and chrome target helpers inspect DOM-like nodes", () => {
    const input = { closest: (selector) => selector.includes("input") ? {} : null };
    const library = { closest: (selector) => selector.includes("[data-block-library]") ? {} : null };
    const canvas = { closest: () => null };

    assert.equal(isEditableTarget(input), true);
    assert.equal(isCanvasChromeTarget(input), true);
    assert.equal(isCanvasChromeTarget(library), true);
    assert.equal(isCanvasChromeTarget(canvas), false);
    assert.equal(isEditableTarget(null), false);

    const canvasGrab = {
        closest(selector) {
            return selector.includes(".cursor-grab") ? this : null;
        },
    };
    const unit = {
        closest(selector) {
            return selector.includes("[data-uuid]") ? this : null;
        },
    };
    assert.equal(canStartEmptyCanvasPan(canvasGrab), true);
    assert.equal(canStartEmptyCanvasPan(unit), false);
});
