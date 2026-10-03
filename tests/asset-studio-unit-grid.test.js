import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { AssetStudioUnitGrid } from "../app/3d/editor/assets/AssetStudioUnitGrid.js";
import { raiseStepToBudget, gridPlanSignature, planAssetStudioUnitGrid } from "../app/3d/editor/assets/assetStudioUnitGridPlan.js";
import { formatSignedUnitLabel } from "../app/3d/editor/assets/assetStudioUnitScale.js";

const VIEW = { fovDegrees: 45, viewportWidthPx: 800, viewportHeightPx: 600 };

function segments(flat) {
    const lines = [];
    for (let index = 0; index < flat.length; index += 6) {
        lines.push({
            a: [flat[index], flat[index + 1], flat[index + 2]],
            b: [flat[index + 3], flat[index + 4], flat[index + 5]],
        });
    }
    return lines;
}

function planeById(plan, id) {
    return plan.planes.find((plane) => plane.id === id);
}

function allLines(plane, axes = null) {
    const lines = [...segments(plane.minor), ...segments(plane.major)];
    if (!axes) return lines;
    const onPlane = { xy: ["x", "y"], xz: ["x", "z"], yz: ["y", "z"] }[plane.id] ?? [];
    for (const axis of onPlane) lines.push(...segments(axes[axis]));
    return lines;
}

function isMultiple(value, step) {
    const quotient = value / step;
    return Math.abs(quotient - Math.round(quotient)) <= 1e-4;
}

/** Constant coordinates of lines that run perpendicular to `axis` (0=x, 1=y, 2=z). */
function lineConstants(plane, axis, axes = null) {
    return allLines(plane, axes)
        .filter((line) => Math.abs(line.a[axis] - line.b[axis]) <= 1e-6)
        .map((line) => line.a[axis])
        .sort((left, right) => left - right);
}

function assertSpacing(values, step) {
    assert.ok(values.length >= 2, `expected a run of grid lines, got ${values.length}`);
    for (let index = 1; index < values.length; index += 1) {
        const gap = values[index] - values[index - 1];
        assert.ok(Math.abs(gap - step) <= 1e-6, `gap ${gap} != ${step}`);
    }
}

test("planAssetStudioUnitGrid draws xy, xz, and yz on the minor step", () => {
    const plan = planAssetStudioUnitGrid({ target: { x: 0, y: 0, z: 0 }, distance: 12, ...VIEW });
    assert.deepEqual(plan.planes.map((plane) => plane.id), ["xy", "xz", "yz"]);
    const fixedAxis = { xy: 2, xz: 1, yz: 0 };
    for (const plane of plan.planes) {
        const axis = fixedAxis[plane.id];
        for (const line of allLines(plane)) {
            assert.ok(Math.abs(line.a[axis] - line.b[axis]) <= 1e-6);
            assert.ok(Math.abs(line.a[axis] - plan.origin[["x", "y", "z"][axis]]) <= 1e-5);
        }
        const along = axis === 0 ? 1 : 0;
        assertSpacing(lineConstants(plane, along, plan.axes), plan.minorMeters);
        for (const value of lineConstants(plane, along, plan.axes)) assert.ok(isMultiple(value, plan.minorMeters));
    }
});

test("a closer camera uses a smaller step and more divisions across the shared span", () => {
    const far = planAssetStudioUnitGrid({ target: { x: 0, y: 0, z: 0 }, distance: 40, ...VIEW });
    const near = planAssetStudioUnitGrid({ target: { x: 0, y: 0, z: 0 }, distance: 4, ...VIEW });
    assert.ok(near.minorMeters < far.minorMeters, `${near.minorMeters} should be finer than ${far.minorMeters}`);
    const span = Math.min(far.halfExtent, near.halfExtent);
    const within = (plan) => lineConstants(planeById(plan, "xz"), 0, plan.axes).filter((value) => value >= -span && value <= span);
    assert.ok(within(near).length > within(far).length, `near ${within(near).length} vs far ${within(far).length}`);
});

test("grid lines stay on multiples of the step when the target is off-grid", () => {
    const plan = planAssetStudioUnitGrid({
        target: { x: 0.37, y: -1.14, z: 2.03 },
        distance: 8,
        ...VIEW,
    });
    for (const axis of ["x", "y", "z"]) assert.ok(isMultiple(plan.origin[axis], plan.minorMeters));
    const constants = lineConstants(planeById(plan, "xz"), 0, plan.axes);
    assert.ok(constants.length > 0);
    for (const value of constants) assert.ok(isMultiple(value, plan.minorMeters), `${value} / ${plan.minorMeters}`);
});

test("each axis stays within the line budget", () => {
    const crowded = planAssetStudioUnitGrid({
        target: { x: 0, y: 0, z: 0 },
        distance: 30,
        fovDegrees: 60,
        viewportWidthPx: 20000,
        viewportHeightPx: 20000,
    });
    for (const plane of crowded.planes) {
        for (const axis of [0, 1, 2]) {
            const count = new Set(lineConstants(plane, axis, crowded.axes).map((value) => Math.round(value * 1e6))).size;
            if (count === 0) continue;
            assert.ok(count <= 160, `${plane.id} axis ${axis} has ${count} lines`);
        }
    }
    const raised = raiseStepToBudget({ minorMeters: 0.01, majorMeters: 0.1 }, 10, 160);
    assert.equal(raised.minorMeters, 0.2);
    assert.equal(raised.majorMeters, 2);
});

test("gridPlanSignature changes when the snapped origin moves by a cell", () => {
    const left = planAssetStudioUnitGrid({ target: { x: 0.05, y: 0, z: 0 }, distance: 12, ...VIEW });
    const same = planAssetStudioUnitGrid({ target: { x: 0.05, y: 0, z: 0 }, distance: 12, ...VIEW });
    const shifted = planAssetStudioUnitGrid({
        target: { x: 0.05 + left.minorMeters, y: 0, z: 0 },
        distance: 12,
        ...VIEW,
    });
    assert.equal(gridPlanSignature(left), gridPlanSignature(same));
    assert.notEqual(gridPlanSignature(left), gridPlanSignature(shifted));
});

test("major lines are the minor multiples and are not repeated", () => {
    const plan = planAssetStudioUnitGrid({ target: { x: 0, y: 0, z: 0 }, distance: 12, ...VIEW });
    const plane = planeById(plan, "xz");
    const minorX = segments(plane.minor)
        .filter((line) => Math.abs(line.a[0] - line.b[0]) <= 1e-6)
        .map((line) => line.a[0]);
    const majorX = segments(plane.major)
        .filter((line) => Math.abs(line.a[0] - line.b[0]) <= 1e-6)
        .map((line) => line.a[0]);
    assert.ok(majorX.length > 0);
    for (const value of majorX) assert.ok(isMultiple(value, plan.majorMeters));
    for (const value of minorX) assert.equal(isMultiple(value, plan.majorMeters), false);
});

function majorTicks(center, halfExtent, major) {
    const first = Math.ceil((center - halfExtent - 1e-9) / major);
    const last = Math.floor((center + halfExtent + 1e-9) / major);
    const coords = [];
    for (let index = first; index <= last; index += 1) coords.push(index * major);
    return coords;
}

test("major ticks are labeled with signed measurements and zero appears once", () => {
    const plan = planAssetStudioUnitGrid({ target: { x: 0, y: 0, z: 0 }, distance: 12, ...VIEW });
    const offset = 16 * plan.metersPerPixel;
    const zeros = plan.labels.filter((label) => label.text === "0");
    assert.equal(zeros.length, 1);
    assert.equal(zeros[0].axis, "origin");
    assert.equal(zeros[0].meters, 0);
    assert.ok(Math.abs(zeros[0].position.x - offset) <= 1e-6);
    assert.ok(Math.abs(zeros[0].position.y) <= 1e-6);
    assert.ok(Math.abs(zeros[0].position.z + offset) <= 1e-6);

    for (const axis of ["x", "y", "z"]) {
        const ticks = majorTicks(plan.origin[axis], plan.halfExtent, plan.majorMeters);
        const labeled = plan.labels.filter((label) => label.axis === axis);
        assert.ok(labeled.length <= ticks.length);
        for (const meters of ticks) {
            if (Math.abs(meters) <= 1e-6) continue;
            const label = labeled.find((entry) => Math.abs(entry.meters - meters) <= 1e-6);
            assert.ok(label, `${axis} missing ${meters}`);
            assert.equal(label.text, formatSignedUnitLabel(meters));
            const shift = axis === "x" ? label.position.z - plan.origin.z : label.position.x - plan.origin.x;
            assert.ok(Math.abs(shift - (axis === "x" ? -offset : offset)) <= 1e-5);
            assert.ok(Math.abs(label.position[axis] - meters) <= 1e-6);
        }
    }

    const far = planAssetStudioUnitGrid({ target: { x: 0, y: 0, z: 0 }, distance: 40, ...VIEW });
    const near = planAssetStudioUnitGrid({ target: { x: 0, y: 0, z: 0 }, distance: 4, ...VIEW });
    assert.notEqual(near.majorMeters, far.majorMeters);
    const texts = (entry) => entry.labels.map((label) => label.text).join("|");
    assert.notEqual(texts(near), texts(far));
});

test("AssetStudioUnitGrid rebuilds on a finer zoom and skips work while hidden", () => {
    const grid = new AssetStudioUnitGrid(THREE);
    const scene = new THREE.Scene();
    scene.add(grid.group);
    assert.equal(grid.group.name, "asset-studio-units");
    assert.equal(grid.group.userData.skipEnvironmentSelection, true);
    assert.equal(grid.minor.material.depthWrite, false);
    const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.01, 10000);
    const target = new THREE.Vector3();
    const syncAt = (distance) => {
        camera.position.set(distance, distance * 0.7, distance);
        return grid.sync({ camera, target, viewportWidth: 800, viewportHeight: 600 });
    };
    const far = syncAt(40);
    const farGeometry = grid.minor.geometry;
    assert.equal(grid.axes.length, 3);
    assert.equal(grid.axes[0].geometry.getAttribute("position").count, 2);
    assert.equal(grid.labels.name, "asset-studio-unit-labels");
    assert.equal(grid.labels.children.length, 0, "headless sync does not require a document canvas");
    const near = syncAt(4);
    assert.ok(near.minorMeters < far.minorMeters);
    assert.notEqual(near.label, far.label);
    assert.notEqual(grid.minor.geometry, farGeometry);
    const settled = grid.minor.geometry;
    syncAt(4.01);
    assert.equal(grid.minor.geometry, settled);
    grid.setVisible(false);
    const hidden = syncAt(0.25);
    assert.equal(hidden.label, near.label);
    assert.equal(grid.minor.geometry, settled);
    assert.equal(grid.group.visible, false);
    grid.setVisible(true);
    const closer = syncAt(0.25);
    assert.ok(closer.minorMeters < near.minorMeters);
    assert.notEqual(grid.minor.geometry, settled);
    grid.dispose();
    assert.equal(grid.group.parent, null);
});
