import assert from "node:assert/strict";
import test from "node:test";

import { worldToScreen } from "../app/3d/editor/map/mapCoords.js";
import { occupancyScreenRect, paintOccupancyRgba } from "../app/spatial/planview/occupancy/paint.js";

test("a blocked cell is opaque and a clear cell stays transparent", () => {
    const cells = new Uint8Array(8);
    cells[6] = 1;
    const rgba = paintOccupancyRgba(cells, 4, 2, "cost");
    assert.equal(rgba[3], 0);
    assert.ok(rgba[6 * 4 + 3] > 0);
    assert.equal(rgba.length, 32);
});

test("the screen rect matches the world corners and does not flip the rows", () => {
    const viewport = { centerX: 0, centerZ: 0, zoom: 1 };
    const size = { width: 200, height: 100 };
    const sample = { originX: 1, originZ: 2, width: 4, height: 2, resolutionM: 0.5, yawRad: 0 };
    const rect = occupancyScreenRect(sample, viewport, size);
    const near = worldToScreen({ x: 1, z: 2 }, viewport, size);
    const far = worldToScreen({ x: 3, z: 3 }, viewport, size);
    assert.equal(rect.x, near.x);
    assert.equal(rect.y, near.y);
    assert.equal(rect.width, far.x - near.x);
    assert.equal(rect.height, far.y - near.y);
    assert.ok(rect.height > 0);
    assert.equal(occupancyScreenRect({ ...sample, yawRad: Math.PI / 2 }, viewport, size).rotationDeg, -90);
});
