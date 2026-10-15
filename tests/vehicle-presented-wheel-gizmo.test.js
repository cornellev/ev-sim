import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

import {
    presentedWheelStructureKey,
    syncPresentedWheelPositions,
} from "../app/vehicles/editor/presentedWheelSync.js";

function manifest(wheels, extras = {}) {
    return {
        model: {
            scale: 1,
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            offset: { x: 0, y: 0, z: 0 },
            hiddenNodeIndices: [],
            ...extras.model,
        },
        boundingBox: {
            size: { x: 2, y: 1, z: 1 },
            center: { x: 0, y: 0.5, z: 0 },
            ...extras.boundingBox,
        },
        wheels,
    };
}

function wheel(id, position, extras = {}) {
    return {
        id,
        axle: "front",
        side: id.endsWith("left") ? "left" : "right",
        steerable: true,
        radius: 0.25,
        width: 0.15,
        position,
        ...extras,
    };
}

function place(group, wheels) {
    for (const child of [...group.children]) group.remove(child);
    const pivots = new Map();
    for (const entry of wheels) {
        const pivot = new THREE.Group();
        pivot.userData.presentedWheel = true;
        pivot.userData.pick = { kind: "wheel", id: entry.id };
        pivot.position.set(entry.position.x, entry.position.y, entry.position.z);
        group.add(pivot);
        pivots.set(entry.id, pivot);
    }
    return pivots;
}

function fakeGizmo(object) {
    return {
        object,
        dragging: false,
        detachCount: 0,
        detach() {
            this.detachCount += 1;
            this.object = undefined;
        },
        attach(next) {
            this.object = next;
        },
    };
}

const pair = [
    wheel("front-left", { x: 1, y: 0.25, z: 0.6 }),
    wheel("front-right", { x: 1, y: 0.25, z: -0.6 }),
];

test("a position edit keeps the selected wheel pivot in the scene", () => {
    const group = new THREE.Group();
    const pivots = place(group, pair);
    const source = manifest(pair);
    const key = presentedWheelStructureKey(source);
    const moved = manifest(pair.map((entry) => (
        entry.id === "front-left"
            ? { ...entry, position: { x: 1.4, y: 0.25, z: 0.6 } }
            : entry
    )));
    assert.equal(presentedWheelStructureKey(moved), key);
    assert.equal(presentedWheelStructureKey(manifest([...pair].reverse())), key);
    const gizmo = fakeGizmo(pivots.get("front-left"));
    let rebuilds = 0;
    const result = syncPresentedWheelPositions({
        wheelsGroup: group,
        manifest: moved,
        structureKey: key,
        gizmo,
        selection: { kind: "wheel", id: "front-left" },
        rebuild: () => { rebuilds += 1; },
    });
    assert.equal(result.rebuilt, false);
    assert.equal(rebuilds, 0);
    assert.equal(gizmo.detachCount, 0);
    assert.equal(gizmo.object, pivots.get("front-left"));
    assert.equal(gizmo.object.parent, group);
    assert.equal(gizmo.object.position.x, 1.4);
    assert.equal(pivots.get("front-right").position.z, -0.6);
});

test("a wheel drag leaves the dragged pivot in place and moves its partner", () => {
    const group = new THREE.Group();
    const pivots = place(group, pair);
    const source = manifest(pair);
    const dragged = pivots.get("front-left");
    dragged.position.set(2, 0.25, 0.6);
    const moved = manifest([
        { ...pair[0], position: { x: 1.5, y: 0.25, z: 0.7 } },
        { ...pair[1], position: { x: 1.5, y: 0.25, z: -0.7 } },
    ]);
    const gizmo = fakeGizmo(dragged);
    gizmo.dragging = true;
    const result = syncPresentedWheelPositions({
        wheelsGroup: group,
        manifest: moved,
        structureKey: presentedWheelStructureKey(source),
        gizmo,
        selection: { kind: "wheel", id: "front-left" },
        rebuild: () => { throw new Error("position drag must not rebuild pivots"); },
    });
    assert.equal(result.rebuilt, false);
    assert.equal(gizmo.object, dragged);
    assert.equal(gizmo.object.parent, group);
    assert.equal(dragged.position.x, 2);
    assert.equal(dragged.position.z, 0.6);
    assert.equal(pivots.get("front-right").position.x, 1.5);
    assert.equal(pivots.get("front-right").position.z, -0.7);
});

test("a structural wheel change reattaches the gizmo to the replacement pivot", () => {
    const group = new THREE.Group();
    const pivots = place(group, pair);
    const source = manifest(pair);
    const changed = manifest(pair.map((entry) => ({ ...entry, radius: 0.3 })));
    assert.notEqual(presentedWheelStructureKey(changed), presentedWheelStructureKey(source));
    const previous = pivots.get("front-left");
    const gizmo = fakeGizmo(previous);
    const result = syncPresentedWheelPositions({
        wheelsGroup: group,
        manifest: changed,
        structureKey: presentedWheelStructureKey(source),
        gizmo,
        selection: { kind: "wheel", id: "front-left" },
        rebuild: () => { place(group, changed.wheels); },
    });
    assert.equal(result.rebuilt, true);
    assert.equal(gizmo.detachCount, 1);
    assert.notEqual(gizmo.object, previous);
    assert.equal(previous.parent, null);
    assert.equal(gizmo.object.parent, group);
    assert.equal(gizmo.object.userData.pick.id, "front-left");
});

test("a position edit leaves a bound wheel pivot on its mesh center", () => {
    const group = new THREE.Group();
    const pivots = place(group, pair);
    const bound = pivots.get("front-left");
    bound.userData.boundWheel = true;
    bound.position.set(1.2, 0.3, 0.75);
    const source = manifest(pair);
    const moved = manifest(pair.map((entry) => (
        entry.id === "front-left"
            ? { ...entry, position: { x: 0, y: 0, z: 0 } }
            : entry
    )));
    const result = syncPresentedWheelPositions({
        wheelsGroup: group,
        manifest: moved,
        structureKey: presentedWheelStructureKey(source),
        gizmo: fakeGizmo(null),
        selection: null,
        rebuild: () => { throw new Error("bound pivot should stay in place"); },
    });
    assert.equal(result.rebuilt, false);
    assert.equal(bound.position.x, 1.2);
    assert.equal(bound.position.y, 0.3);
    assert.equal(bound.position.z, 0.75);
    assert.equal(pivots.get("front-right").position.z, -0.6);
});

test("a missing pivot rebuilds instead of nudging an empty wheel group", () => {
    const group = new THREE.Group();
    const pivots = place(group, pair);
    group.remove(pivots.get("front-right"));
    const source = manifest(pair);
    let rebuilds = 0;
    const result = syncPresentedWheelPositions({
        wheelsGroup: group,
        manifest: source,
        structureKey: presentedWheelStructureKey(source),
        gizmo: fakeGizmo(pivots.get("front-left")),
        selection: { kind: "wheel", id: "front-left" },
        rebuild: () => {
            rebuilds += 1;
            place(group, source.wheels);
        },
    });
    assert.equal(result.rebuilt, true);
    assert.equal(rebuilds, 1);
    assert.equal(result.structureKey, presentedWheelStructureKey(source));
    assert.equal(group.children.length, 2);
});

test("rebuilding wheels leaves a model gizmo attached to the model", () => {
    const group = new THREE.Group();
    place(group, pair);
    const model = new THREE.Group();
    model.name = "model";
    const source = manifest(pair);
    const changed = manifest(pair.map((entry) => ({ ...entry, radius: 0.4 })));
    const gizmo = fakeGizmo(model);
    syncPresentedWheelPositions({
        wheelsGroup: group,
        manifest: changed,
        structureKey: presentedWheelStructureKey(source),
        gizmo,
        selection: { kind: "model", id: null },
        rebuild: () => { place(group, changed.wheels); },
    });
    assert.equal(gizmo.detachCount, 0);
    assert.equal(gizmo.object, model);
});
