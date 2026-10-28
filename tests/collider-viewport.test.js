import assert from "node:assert/strict";
import test from "node:test";

import { ColliderViewportPreview } from "../app/3d/perception/ColliderViewportPreview.js";
import { colliderViewportGeometry, unconfiguredColliderSource } from "../app/3d/perception/colliderViewportGeometry.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";

function yawedFootprint() {
    const yaw = Math.PI / 4;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const halfX = 2;
    const halfZ = 1;
    const originX = 10;
    const originZ = 20;
    return [
        { x: -halfX, z: -halfZ },
        { x: halfX, z: -halfZ },
        { x: halfX, z: halfZ },
        { x: -halfX, z: halfZ },
    ].map((point) => ({
        x: originX + point.x * cosine + point.z * sine,
        z: originZ - point.x * sine + point.z * cosine,
    }));
}

function pointsOf(shape) {
    const points = [];
    for (let index = 0; index < shape.positions.length; index += 3) {
        points.push([shape.positions[index], shape.positions[index + 1], shape.positions[index + 2]]);
    }
    return points;
}

function hasPoint(points, x, y, z) {
    return points.some((point) => Math.abs(point[0] - x) < 1e-5 && Math.abs(point[1] - y) < 1e-5 && Math.abs(point[2] - z) < 1e-5);
}

function rigidBody() {
    return {
        id: "crate",
        parts: [{ kind: "cuboid", half: { x: 0.5, y: 0.5, z: 0.5 }, offset: { x: 0, y: 0, z: 0 } }],
        body: {
            translation: () => ({ x: 0, y: 2, z: 0 }),
            rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
        },
    };
}

test("a yawed footprint is extruded and the bounds cuboid is not drawn", () => {
    const footprint = yawedFootprint();
    const minX = Math.min(...footprint.map((point) => point.x));
    const minZ = Math.min(...footprint.map((point) => point.z));
    const frame = colliderViewportGeometry({
        staticColliders: [{
            half: { x: 99, y: 99, z: 99 },
            obstacle: {
                footprint,
                triangles: [[0, 1, 2], [0, 2, 3]],
                minY: 0,
                maxY: 3,
            },
            bounds: {
                min: { x: minX, y: 0, z: minZ },
                max: {
                    x: Math.max(...footprint.map((point) => point.x)),
                    y: 3,
                    z: Math.max(...footprint.map((point) => point.z)),
                },
            },
        }],
    });
    const shape = frame.staticShapes[0];
    const points = pointsOf(shape);
    assert.equal(shape.kind, "mesh");
    assert.equal(points.length, 8);
    for (const point of footprint) {
        assert.equal(hasPoint(points, point.x, 0, point.z), true);
        assert.equal(hasPoint(points, point.x, 3, point.z), true);
    }
    assert.equal(footprint.some((point) => Math.abs(point.x - minX) < 1e-9 && Math.abs(point.z - minZ) < 1e-9), false);
    assert.equal(points.some((point) => Math.abs(point[0] - minX) < 1e-9 && Math.abs(point[2] - minZ) < 1e-9), false);
});

test("convex colliders keep their vertices and bounds-only colliders are the bounds box", () => {
    const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const frame = colliderViewportGeometry({
        staticColliders: [
            {
                convex: { vertices, triangles: [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 2, 3]] },
                obstacle: {
                    footprint: [{ x: 8, z: 8 }, { x: 9, z: 8 }, { x: 9, z: 9 }],
                    triangles: [[0, 1, 2]],
                    minY: 0,
                    maxY: 2,
                },
                bounds: { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } },
            },
            {
                bounds: { min: { x: 1, y: 2, z: 3 }, max: { x: 5, y: 6, z: 9 } },
                half: { x: 100, y: 100, z: 100 },
            },
            {
                obstacle: { footprint: [], minY: 0, maxY: 1 },
                bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
            },
        ],
    });
    assert.equal(frame.staticShapes.length, 2);
    assert.deepEqual(pointsOf(frame.staticShapes[0]), vertices);
    assert.deepEqual(frame.staticShapes[1], {
        kind: "box",
        center: { x: 3, y: 4, z: 6 },
        yaw: 0,
        size: { x: 4, y: 4, z: 6 },
    });
});

test("a vehicle box uses the swept center and yaw", () => {
    const frame = colliderViewportGeometry({
        staticColliders: [],
        vehicleStates: [{
            vehicle: {
                position: { x: 10, y: 0, z: -4 },
                rotation: { y: Math.PI / 2 },
                collisionDimensions: { x: 4, y: 2, z: 2 },
                collisionCenter: { x: 1, y: 0.5, z: 0 },
            },
        }],
    });
    assert.equal(frame.vehicles.length, 1);
    const box = frame.vehicles[0];
    assert.equal(box.kind, "box");
    assert.ok(Math.abs(box.center.x - 10) < 1e-9);
    assert.ok(Math.abs(box.center.y - 0.5) < 1e-9);
    assert.ok(Math.abs(box.center.z - (-5)) < 1e-9);
    assert.equal(box.yaw, Math.PI / 2);
    assert.deepEqual(box.size, { x: 4, y: 2, z: 2 });
});

test("the floor grid exists only when the floor collider does", () => {
    const body = rigidBody();
    const off = colliderViewportGeometry({
        preparedWorldDescription: { groundPlane: { y: 1.5, collider: false } },
        rigidBodyStates: [body],
    });
    const empty = colliderViewportGeometry({
        preparedWorldDescription: { groundPlane: { y: 1.5 } },
        rigidBodyStates: [],
    });
    const on = colliderViewportGeometry({
        preparedWorldDescription: { groundPlane: { y: 1.5 } },
        rigidBodyStates: [body],
    });
    assert.equal(off.floor, null);
    assert.equal(empty.floor, null);
    assert.equal(on.floor.y, 1.5);
    assert.deepEqual([on.floor.minX, on.floor.maxX, on.floor.minZ, on.floor.maxZ], [-20, 20, -20, 20]);
    for (let index = 1; index < on.floor.positions.length; index += 3) {
        assert.equal(on.floor.positions[index], 1.5);
    }
});

test("static shapes are kept until the collider list is replaced", () => {
    const entry = { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } };
    const physics = { staticColliders: [entry] };
    const first = colliderViewportGeometry(physics);
    const second = colliderViewportGeometry(physics, first);
    assert.equal(second.staticShapes, first.staticShapes);
    physics.staticColliders = [entry];
    const third = colliderViewportGeometry(physics, second);
    assert.notEqual(third.staticShapes, first.staticShapes);
    assert.equal(third.staticShapes.length, 1);
});

test("an unconfigured world uses its description and skips rigid-body hosts", () => {
    const description = {
        obstacles: [{
            id: "building:a",
            sourceId: "a",
            footprint: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 0, z: 1 }],
            triangles: [[0, 1, 2], [0, 2, 3]],
            minY: 0,
            maxY: 2,
        }],
        primitives: [{
            id: "primitive:box",
            sourceId: "box",
            vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
            triangles: [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 2, 3]],
        }],
        rigidBodies: [{
            id: "box",
            parts: [{ kind: "cuboid", half: { x: 0.5, y: 0.5, z: 0.5 } }],
            position: { x: 4, y: 1, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
        }],
        groundPlane: { y: 0 },
    };
    const frame = colliderViewportGeometry(unconfiguredColliderSource(description, []));
    assert.equal(frame.staticShapes.length, 1);
    assert.equal(frame.staticShapes[0].kind, "mesh");
    assert.equal(frame.rigidBodies.length, 1);
    assert.equal(frame.floor?.y, 0);
    assert.equal(hasPoint(pointsOf(frame.rigidBodies[0]), 3.5, 0.5, -0.5), true);
});

function mockRenderer() {
    return {
        autoClear: true,
        getRenderTarget: () => null,
        getClearColor: () => {},
        getClearAlpha: () => 1,
        setRenderTarget: () => {},
        setClearColor: () => {},
        clear: () => {},
        render: () => {},
    };
}

test("the viewport follows a live rigid body and prefers configured physics", () => {
    let x = 0;
    const physics = {
        preparedWorldDescription: { groundPlane: { y: 0, collider: false } },
        staticColliders: [],
        vehicleStates: [],
        rigidBodyStates: [{
            id: "crate",
            parts: [{ kind: "cuboid", half: { x: 0.5, y: 0.5, z: 0.5 } }],
            body: {
                translation: () => ({ x, y: 1, z: 0 }),
                rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
            },
        }],
    };
    const description = {
        worldDescription: {
            obstacles: [{
                id: "building:a",
                sourceId: "a",
                footprint: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }],
                triangles: [[0, 1, 2], [0, 2, 3]],
                minY: 0,
                maxY: 3,
            }],
        },
    };
    const preview = new ColliderViewportPreview({
        physics: () => physics,
        environment: () => description,
        vehicles: () => ({ vehicles: [] }),
    });
    const renderer = mockRenderer();
    preview.setEnabled(true);
    preview.render(renderer, {});
    const mesh = preview._rigidMeshes.get("crate");
    const before = mesh.geometry.attributes.position.array[0];
    x = 5;
    preview.render(renderer, {});
    assert.ok(Math.abs(mesh.geometry.attributes.position.array[0] - (before + 5)) < 1e-5);
    assert.equal(preview._staticGroup.children.length, 0);
    physics.preparedWorldDescription = null;
    preview.render(renderer, {});
    assert.equal(preview._staticGroup.children.length, 1);
    preview.dispose();
});

test("a vehicle added after physics configure is still drawn", () => {
    const preview = new ColliderViewportPreview({
        physics: () => ({
            preparedWorldDescription: { groundPlane: { y: 0, collider: false } },
            staticColliders: [],
            vehicleStates: [],
            rigidBodyStates: [],
        }),
        vehicles: () => ({
            vehicles: [{
                position: { x: 2, y: 0, z: 3 },
                rotation: { y: 0 },
                collisionDimensions: { x: 4, y: 2, z: 2 },
                collisionCenter: { x: 0, y: 1, z: 0 },
            }],
        }),
    });
    preview.setEnabled(true);
    preview.render(mockRenderer(), {});
    assert.equal(preview._vehicleMeshes.length, 1);
    assert.ok(Math.abs(preview._vehicleMeshes[0].position.x - 2) < 1e-9);
    assert.ok(Math.abs(preview._vehicleMeshes[0].position.y - 1) < 1e-9);
    preview.dispose();
});

test("enabling either viewport disables the other and does not advance time", () => {
    const engine = new SimulationEngine({});
    const rendered = [];
    engine.scene = { name: "main" };
    engine.camera = {};
    engine.renderer = {
        autoClear: true,
        getRenderTarget: () => null,
        getClearColor: () => {},
        getClearAlpha: () => 1,
        setRenderTarget: () => {},
        setClearColor: () => {},
        clear: () => {},
        render: (scene) => rendered.push(scene),
    };
    engine.lidarViewport._ensureShader = () => {};
    const steps = engine.steps;
    const time = engine.time;
    engine.setColliderViewportEnabled(true);
    assert.equal(engine.colliderViewport.enabled, true);
    assert.equal(engine.lidarViewport.enabled, false);
    assert.equal(rendered.includes(engine.scene), false);
    assert.equal(rendered.length > 0, true);
    engine.setLidarViewportEnabled(true);
    assert.equal(engine.lidarViewport.enabled, true);
    assert.equal(engine.colliderViewport.enabled, false);
    assert.equal(rendered.includes(engine.scene), false);
    assert.equal(engine.steps, steps);
    assert.equal(engine.time, time);
    engine.dispose();
});
