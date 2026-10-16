import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { VehicleFloorUnitGrid } from "../app/vehicles/editor/VehicleFloorUnitGrid.js";
import { floorGridPlanSignature, planVehicleFloorUnitGrid } from "../app/vehicles/editor/vehicleFloorUnitGridPlan.js";
import { formatSignedUnitLabel } from "../app/3d/editor/assets/assetStudioUnitScale.js";

const VIEW = { fovDegrees: 50, viewportWidthPx: 800, viewportHeightPx: 600 };

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

function allSegments(plan) {
    return [
        ...segments(plan.minor),
        ...segments(plan.major),
        ...(plan.axes.x ? segments(plan.axes.x) : []),
        ...(plan.axes.z ? segments(plan.axes.z) : []),
    ];
}

function isMultiple(value, step) {
    const quotient = value / step;
    return Math.abs(quotient - Math.round(quotient)) <= 1e-4;
}

/** Constant coordinates of lines perpendicular to `axis` (0=x, 1=y, 2=z). */
function lineConstants(plan, axis) {
    return allSegments(plan)
        .filter((line) => Math.abs(line.a[axis] - line.b[axis]) <= 1e-6)
        .map((line) => line.a[axis])
        .sort((left, right) => left - right);
}

test("the floor grid is an XZ plane at y = 0 with no vertical labels", () => {
    const plan = planVehicleFloorUnitGrid({ target: { x: 0, y: 0.6, z: 0 }, distance: 12, ...VIEW });
    assert.deepEqual(plan.origin, { x: 0, y: 0, z: 0 });
    assert.ok(allSegments(plan).length > 0);
    for (const line of allSegments(plan)) {
        assert.ok(Math.abs(line.a[1]) <= 1e-6);
        assert.ok(Math.abs(line.b[1]) <= 1e-6);
    }
    assert.ok(plan.axes.x);
    assert.ok(plan.axes.z);
    assert.equal(plan.axes.x[2], 0);
    assert.equal(plan.axes.x[5], 0);
    assert.equal(plan.axes.z[0], 0);
    assert.equal(plan.axes.z[3], 0);
    assert.ok(plan.labels.length > 1);
    for (const label of plan.labels) {
        assert.ok(label.axis === "x" || label.axis === "z" || label.axis === "origin");
        assert.equal(label.position.y, 0);
        assert.equal(label.text, label.axis === "origin" ? "0" : formatSignedUnitLabel(label.meters));
    }
    const zeros = plan.labels.filter((label) => label.text === "0");
    assert.equal(zeros.length, 1);
    assert.equal(zeros[0].axis, "origin");
});

test("a closer camera uses a smaller step and keeps shared ticks on the same world coordinates", () => {
    const far = planVehicleFloorUnitGrid({ target: { x: 0, y: 0.6, z: 0 }, distance: 40, ...VIEW });
    const near = planVehicleFloorUnitGrid({ target: { x: 0, y: 0.6, z: 0 }, distance: 4, ...VIEW });
    assert.ok(near.minorMeters < far.minorMeters, `${near.minorMeters} should be finer than ${far.minorMeters}`);
    const span = Math.min(far.halfExtent, near.halfExtent);
    const within = (plan) => lineConstants(plan, 0).filter((value) => value >= -span && value <= span);
    assert.ok(within(near).length > within(far).length);
    const nearX = within(near);
    const shared = within(far).filter((value) => nearX.some((other) => Math.abs(other - value) <= 1e-6));
    assert.ok(shared.length > 0);
    for (const value of shared) assert.ok(isMultiple(value, far.minorMeters));
    assert.notEqual(near.majorMeters, far.majorMeters);
    const texts = (entry) => entry.labels.map((label) => label.text).join("|");
    assert.notEqual(texts(near), texts(far));
});

test("panning does not move the origin or shift tick coordinates", () => {
    const home = planVehicleFloorUnitGrid({ target: { x: 0, y: 0.6, z: 0 }, distance: 12, ...VIEW });
    const panned = planVehicleFloorUnitGrid({ target: { x: 2.2, y: 4, z: -1.4 }, distance: 12, ...VIEW });
    assert.deepEqual(panned.origin, home.origin);
    const homeZero = home.labels.find((label) => label.axis === "origin");
    const pannedZero = panned.labels.find((label) => label.axis === "origin");
    assert.ok(homeZero);
    assert.ok(pannedZero);
    assert.deepEqual(pannedZero.position, homeZero.position);
    const homeTick = home.labels.find((label) => label.axis === "x" && panned.labels.some((other) => (
        other.axis === "x" && Math.abs(other.meters - label.meters) <= 1e-6
    )));
    const pannedTick = panned.labels.find((label) => label.axis === "x" && Math.abs(label.meters - homeTick.meters) <= 1e-6);
    assert.ok(pannedTick);
    assert.deepEqual(pannedTick.position, homeTick.position);
    assert.equal(pannedTick.position.x, homeTick.meters);
    for (const value of lineConstants(panned, 0)) assert.ok(isMultiple(value, panned.minorMeters));
    for (const value of lineConstants(panned, 2)) assert.ok(isMultiple(value, panned.minorMeters));

    const away = planVehicleFloorUnitGrid({
        target: { x: home.halfExtent * 4, y: 0.6, z: home.halfExtent * 4 },
        distance: 12,
        ...VIEW,
    });
    assert.equal(away.labels.some((label) => label.axis === "origin"), false);
    assert.equal(away.axes.x, null);
    assert.equal(away.axes.z, null);
    const awayX = lineConstants(away, 0);
    assert.ok(awayX.length > 0);
    assert.ok(Math.min(...awayX) > 0);
    assert.equal(floorGridPlanSignature(home), floorGridPlanSignature(planVehicleFloorUnitGrid({
        target: { x: 0, y: 0.6, z: 0 },
        distance: 12,
        ...VIEW,
    })));
    assert.notEqual(floorGridPlanSignature(home), floorGridPlanSignature(panned));
});

test("each floor axis stays within the line budget and major lines are not repeated", () => {
    const crowded = planVehicleFloorUnitGrid({
        target: { x: 0, y: 0, z: 0 },
        distance: 30,
        fovDegrees: 60,
        viewportWidthPx: 20000,
        viewportHeightPx: 20000,
    });
    for (const axis of [0, 2]) {
        const count = new Set(lineConstants(crowded, axis).map((value) => Math.round(value * 1e6))).size;
        assert.ok(count <= 160, `axis ${axis} has ${count} lines`);
        assert.ok(count > 0);
    }
    const plan = planVehicleFloorUnitGrid({ target: { x: 0, y: 0.6, z: 0 }, distance: 12, ...VIEW });
    const minorX = segments(plan.minor)
        .filter((line) => Math.abs(line.a[0] - line.b[0]) <= 1e-6)
        .map((line) => line.a[0]);
    const majorX = segments(plan.major)
        .filter((line) => Math.abs(line.a[0] - line.b[0]) <= 1e-6)
        .map((line) => line.a[0]);
    assert.ok(majorX.length > 0);
    for (const value of majorX) assert.ok(isMultiple(value, plan.majorMeters));
    for (const value of minorX) assert.equal(isMultiple(value, plan.majorMeters), false);
});

test("VehicleFloorUnitGrid rebuilds on a finer zoom and ignores camera orbit around a fixed target", () => {
    const grid = new VehicleFloorUnitGrid(THREE);
    const scene = new THREE.Scene();
    scene.add(grid.group);
    assert.equal(grid.group.name, "vehicle-floor-units");
    assert.equal(grid.minor.material.fog, false);
    assert.equal(grid.minor.material.depthWrite, false);
    const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.01, 10000);
    const target = new THREE.Vector3(0, 0.6, 0);
    const syncAt = (x, y, z) => {
        camera.position.set(x, y, z);
        return grid.sync({ camera, target, viewportWidth: 800, viewportHeight: 600 });
    };
    const far = syncAt(10, 5, 0);
    const farGeometry = grid.minor.geometry;
    assert.equal(grid.xAxis.geometry.getAttribute("position").count, 2);
    assert.equal(grid.zAxis.geometry.getAttribute("position").count, 2);
    assert.equal(grid.labels.children.length, 0, "headless sync does not require a document canvas");
    assert.equal(grid.group.position.x, 0);
    assert.equal(grid.group.position.y, 0);
    assert.equal(grid.group.position.z, 0);
    const orbited = syncAt(0, 5, 10);
    assert.equal(orbited.minorMeters, far.minorMeters);
    assert.equal(orbited.label, far.label);
    assert.equal(grid.minor.geometry, farGeometry);
    const near = syncAt(2, 1, 0);
    assert.ok(near.minorMeters < far.minorMeters);
    assert.notEqual(near.label, far.label);
    assert.notEqual(grid.minor.geometry, farGeometry);
    const settled = grid.minor.geometry;
    syncAt(2.01, 1, 0);
    assert.equal(grid.minor.geometry, settled);
    grid.setVisible(false);
    const hidden = syncAt(0.4, 0.2, 0);
    assert.equal(hidden.label, near.label);
    assert.equal(grid.minor.geometry, settled);
    assert.equal(grid.group.visible, false);
    grid.setVisible(true);
    const closer = syncAt(0.4, 0.2, 0);
    assert.ok(closer.minorMeters < near.minorMeters);
    assert.notEqual(grid.minor.geometry, settled);
    const shifted = new THREE.Vector3(30, 0.6, 30);
    camera.position.set(40, 5, 30);
    grid.sync({ camera, target: shifted, viewportWidth: 800, viewportHeight: 600 });
    assert.equal(grid.group.position.x, 0);
    assert.equal(grid.group.position.z, 0);
    assert.equal(grid.xAxis.visible, false);
    assert.equal(grid.zAxis.visible, false);
    grid.dispose();
    assert.equal(grid.group.parent, null);
});
