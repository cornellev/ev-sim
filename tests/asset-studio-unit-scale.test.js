import assert from "node:assert/strict";
import test from "node:test";

import {
    formatUnitLabel,
    selectUnitStep,
    visibleMetersAtTarget,
} from "../app/3d/editor/assets/assetStudioUnitScale.js";

test("visibleMetersAtTarget measures the orbit-target plane from fov and viewport", () => {
    const view = visibleMetersAtTarget({
        distance: 10,
        fovDegrees: 90,
        viewportHeightPx: 100,
        viewportWidthPx: 200,
    });
    assert.ok(Math.abs(view.height - 20) < 1e-9);
    assert.ok(Math.abs(view.width - 40) < 1e-9);
    assert.ok(Math.abs(view.metersPerPixel - 0.2) < 1e-9);
});

test("selectUnitStep walks the 1-2-5 ladder as the viewed height halves and doubles", () => {
    const viewport = { fovDegrees: 90, viewportHeightPx: 600, viewportWidthPx: 800 };
    const at = (distance) => visibleMetersAtTarget({ distance, ...viewport }).metersPerPixel;
    const stepAt = (distance) => selectUnitStep(at(distance)).minorMeters;

    assert.equal(stepAt(25), 1);
    assert.equal(stepAt(12.5), 0.5);
    assert.equal(stepAt(50), 2);
    assert.equal(selectUnitStep(at(25)).majorMeters, 10);
});

test("selectUnitStep clamps extreme zoom to 1 mm and 1 km", () => {
    assert.deepEqual(selectUnitStep(1e-9), { minorMeters: 0.001, majorMeters: 0.01 });
    assert.deepEqual(selectUnitStep(1e6), { minorMeters: 1000, majorMeters: 10000 });
});

test("formatUnitLabel names the minor cell in mm, cm, m, or km", () => {
    assert.equal(formatUnitLabel(0.001), "1 mm");
    assert.equal(formatUnitLabel(0.002), "2 mm");
    assert.equal(formatUnitLabel(0.01), "1 cm");
    assert.equal(formatUnitLabel(0.05), "5 cm");
    assert.equal(formatUnitLabel(0.1), "10 cm");
    assert.equal(formatUnitLabel(1), "1 m");
    assert.equal(formatUnitLabel(2), "2 m");
    assert.equal(formatUnitLabel(1000), "1 km");
});
