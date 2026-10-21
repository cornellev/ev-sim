import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { hashAssetMetric } from "../app/editor-assets/AssetDefinition.js";
import { PHYSICS_CAPABILITY_ID_V2, createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { PhysicsEngine } from "../app/physics/PhysicsEngine.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import {
    createBoxLidarTwin,
    createLidarGeometryResource,
    hashLidarGeometry,
    LIDAR_GEOMETRY_KIND,
    LIDAR_GEOMETRY_VERSION,
} from "../app/simulation/lidar/LidarGeometry.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { assertWorldResource, compareUtf8, createWorldDescription, createWorldResource } from "../app/simulation/world/WorldDescription.js";

const METRIC = {
    version: 1,
    collision: [{
        id: "body",
        kind: "convex",
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
        triangles: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
    }],
    lidar: [],
};

function worldHash(document) {
    return createWorldResource({
        environmentId: document.environmentId,
        templateId: "blank",
        document: document.snapshot(),
    }).hash;
}

function worldOf(document) {
    return createWorldDescription({
        environmentId: document.environmentId,
        templateId: "blank",
        document: document.snapshot(),
    });
}

function yard() {
    resetDocumentIdCounter();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    return { document, service: createEnvironmentCommandService({ document }) };
}

async function startPhysics(document, vehicles = []) {
    const worldDescription = worldOf(document);
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    });
    await physics.configureRun({
        manifest: {},
        worldDescription,
        backendSelection: createPhysicsBackendSelection(worldDescription),
    });
    return physics;
}

function poseOf(physics, id) {
    return physics.rigidBodyPoses().find((pose) => pose.id === id);
}

function horizontalSpeed(physics, id) {
    const velocity = physics.rigidBodyById.get(id).body.linvel();
    return Math.hypot(velocity.x, velocity.z);
}

test("putRigidBody replaces a body and rejects a group", () => {
    const { document, service } = yard();
    const group = service.run("createObject", { typeId: "group", name: "Group" });
    assert.equal(service.run("addPrimitive", { id: "box", shape: "box", x: 0, y: 1, z: 0, size: { x: 1, y: 1, z: 1 } }).ok, true);
    const created = service.run("putRigidBody", { objectId: "box", rigidBody: { mass: 9, bodyType: "kinematic" } });
    assert.equal(created.ok, true, JSON.stringify(created.issues));
    assert.equal(document.getObject("box").components.rigidBody.mass, 9);
    assert.equal(document.getObject("box").components.rigidBody.bodyType, "kinematic");
    assert.equal(document.getObject("box").components.rigidBody.useGravity, true);
    const replaced = service.run("putRigidBody", {
        objectId: "box",
        rigidBody: { mass: 2, useGravity: false, constantForce: { x: 3, y: 0, z: 0 } },
    });
    assert.equal(replaced.ok, true, JSON.stringify(replaced.issues));
    assert.equal(document.getObject("box").components.rigidBody.mass, 2);
    assert.equal(document.getObject("box").components.rigidBody.useGravity, false);
    assert.equal(document.getObject("box").components.rigidBody.constantForce.x, 3);
    assert.equal(service.run("putRigidBody", { objectId: "box", rigidBody: { mass: 0 } }).ok, false);
    assert.equal(document.getObject("box").components.rigidBody.mass, 2);
    assert.equal(service.run("putRigidBody", { objectId: group.result.objectId, rigidBody: { mass: 2 } }).ok, false);
});

test("rigid body commands reject bad hosts and fields, and round-trip undo without changing a body-free hash", () => {
    const { document, service } = yard();
    const bare = worldHash(document);
    const group = service.run("createObject", { typeId: "group", name: "Group" });
    assert.equal(service.run("addRigidBody", { objectId: group.result.objectId }).ok, false);
    const box = service.run("addPrimitive", { id: "box", shape: "box", x: 0, y: 1, z: 0, size: { x: 1, y: 1, z: 1 } });
    assert.equal(box.ok, true, JSON.stringify(box.issues));
    const solid = worldHash(document);
    assert.notEqual(solid, bare);
    const added = service.run("addRigidBody", { objectId: "box" });
    assert.equal(added.ok, true, JSON.stringify(added.issues));
    assert.equal(service.run("addRigidBody", { objectId: "box" }).ok, false);
    assert.equal(document.getObject("box").components.rigidBody.mass, 1);
    assert.equal(service.run("setRigidBody", { objectId: "box", patch: { mass: 0 } }).ok, false);
    assert.equal(document.getObject("box").components.rigidBody.mass, 1);
    assert.equal(service.run("setRigidBody", { objectId: "box", patch: { mass: 4, useGravity: false } }).ok, true);
    assert.equal(document.getObject("box").components.rigidBody.mass, 4);
    assert.equal(document.getObject("box").components.rigidBody.useGravity, false);
    const withBody = worldHash(document);
    assert.notEqual(withBody, solid);
    const described = worldOf(document);
    assert.equal(described.rigidBodies[0].id, "box");
    assert.equal(described.rigidBodies[0].mass, 4);
    assert.equal(described.rigidBodies[0].position, described.rigidBodies[0].position);
    assert.equal(described.rigidBodies[0].velocity, undefined);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.getObject("box").components.rigidBody.mass, 1);
    assert.equal(service.run("removeRigidBody", { objectId: "box" }).ok, true);
    assert.equal(document.getObject("box").components.rigidBody, undefined);
    assert.equal(worldOf(document).rigidBodies, undefined);
    assert.equal(worldHash(document), solid);
    assert.equal(service.bus.undo().ok, true);
    assert.ok(document.getObject("box").components.rigidBody);
    const bareAsset = service.run("placeAssetInstance", {
        record: {
            id: "crate",
            typeId: "asset-instance",
            name: "Crate",
            components: { asset: { assetId: "crate", revision: 1, position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, overrides: {} } },
        },
    });
    assert.equal(bareAsset.ok, true, JSON.stringify(bareAsset.issues));
    assert.match(service.run("addRigidBody", { objectId: "crate" }).error, /collision proxy/);
});

test("a prop and a collision proxy compile a collider, and a cylinder uses a convex part", () => {
    const { document, service } = yard();
    assert.equal(service.run("addFeature", { id: "barrel", type: "barrel", x: 2, z: 3 }).ok, true);
    assert.equal(service.run("addRigidBody", { objectId: "barrel" }).ok, true);
    assert.equal(service.run("addPrimitive", { id: "tube", shape: "cylinder", x: 0, y: 1, z: 0, size: { x: 1, y: 2, z: 1 } }).ok, true);
    assert.equal(service.run("addRigidBody", { objectId: "tube" }).ok, true);
    const metricHash = hashAssetMetric(METRIC);
    const placed = service.run("placeAssetInstance", {
        record: {
            id: "crate",
            typeId: "asset-instance",
            typeVersion: 2,
            name: "Crate",
            parentId: null,
            components: {
                asset: {
                    assetId: "crate",
                    revision: 2,
                    position: { x: 1, y: 0, z: 0 },
                    rotationY: 0,
                    scale: { x: 1, y: 1, z: 1 },
                    overrides: {},
                },
            },
        },
        publishedRevision: { version: 2, revision: 2, metric: METRIC, metricHash },
    });
    assert.equal(placed.ok, true, JSON.stringify(placed.issues));
    const crateBody = service.run("addRigidBody", { objectId: "crate" });
    assert.equal(crateBody.ok, true, JSON.stringify(crateBody.issues));
    const bodies = new Map(worldOf(document).rigidBodies.map((body) => [body.id, body]));
    assert.equal(bodies.get("barrel").parts[0].kind, "cuboid");
    assert.equal(bodies.get("barrel").parts[0].offset.y, 0.5);
    assert.equal(bodies.get("tube").parts[0].kind, "convex");
    assert.equal(bodies.get("crate").parts[0].kind, "convex");
    assert.equal(bodies.get("crate").parts[0].vertices.length, 4);
});

test("dynamic bodies fall onto the floor, take forces, stack, and stop the vehicle", async () => {
    const { document, service } = yard();
    assert.equal(service.run("setFloor", { enabled: true }).ok, true);
    assert.equal(service.run("addPrimitive", { id: "box", shape: "box", x: 0, y: 3, z: 0, size: { x: 1, y: 1, z: 1 } }).ok, true);
    assert.equal(service.run("addRigidBody", { objectId: "box" }).ok, true);
    const falling = await startPhysics(document);
    const dt = 1 / 60;
    for (let step = 0; step < 240; step += 1) {
        falling.beginStep();
        falling.step(dt);
    }
    const rested = poseOf(falling, "box");
    assert.ok(rested.position.y > 0.4 && rested.position.y < 0.7, `rest y ${rested.position.y}`);
    falling.resetRun();
    assert.ok(Math.abs(poseOf(falling, "box").position.y - 3) < 1e-4);
    falling.disposeRun();

    service.run("setRigidBody", { objectId: "box", patch: { useGravity: false } });
    const held = await startPhysics(document);
    for (let step = 0; step < 30; step += 1) held.step(dt);
    assert.ok(Math.abs(poseOf(held, "box").position.y - 3) < 1e-4);
    held.disposeRun();

    service.run("setRigidBody", { objectId: "box", patch: { useGravity: false, constantForce: { x: 10, y: 0, z: 0 } } });
    const pushed = await startPhysics(document);
    for (let step = 0; step < 60; step += 1) pushed.step(dt);
    const forced = poseOf(pushed, "box");
    assert.ok(forced.position.x > 4 && forced.position.x < 6, `force x ${forced.position.x}`);
    pushed.disposeRun();

    service.run("setRigidBody", { objectId: "box", patch: { useGravity: false, constantForce: { x: 0, y: 0, z: 0 } } });
    const impulse = await startPhysics(document);
    impulse.applyImpulse("box", { x: 1, y: 0, z: 0 });
    impulse.step(dt);
    assert.ok(poseOf(impulse, "box").position.x > 0);
    assert.equal(impulse.getDeterministicState().rigidBodies.length, 1);
    impulse.disposeRun();

    const { document: stackDocument, service: stack } = yard();
    stack.run("setFloor", { enabled: true });
    stack.run("addPrimitive", { id: "lower", shape: "box", x: 0, y: 0.5, z: 0, size: { x: 1, y: 1, z: 1 } });
    stack.run("addPrimitive", { id: "upper", shape: "box", x: 0, y: 3, z: 0, size: { x: 1, y: 1, z: 1 } });
    stack.run("addRigidBody", { objectId: "lower" });
    stack.run("addRigidBody", { objectId: "upper" });
    const stacked = await startPhysics(stackDocument);
    for (let step = 0; step < 240; step += 1) stacked.step(dt);
    assert.ok(poseOf(stacked, "lower").position.y < 0.7);
    assert.ok(poseOf(stacked, "upper").position.y > 1.2 && poseOf(stacked, "upper").position.y < 1.9, `stack y ${poseOf(stacked, "upper").position.y}`);
    stacked.disposeRun();

    const { document: hitDocument, service: hit } = yard();
    hit.run("setFloor", { enabled: true });
    hit.run("addPrimitive", { id: "box", shape: "box", x: 4, y: 0.5, z: 0, size: { x: 1, y: 1, z: 1 } });
    hit.run("addRigidBody", { objectId: "box" });
    const vehicle = {
        telemetryId: "ego",
        collisionDimensions: { x: 1, y: 1, z: 1 },
        position: { x: 0, y: 0.5, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const physics = await startPhysics(hitDocument, [vehicle]);
    assert.equal(physics.getDeterministicState().rigidBodies[0].position.x, 4);
    physics.beginStep();
    vehicle.position.x = 6;
    physics.step(dt);
    assert.ok(vehicle.position.x < 3.05 && vehicle.position.x > 2.8, `vehicle x ${vehicle.position.x}`);
    assert.ok(poseOf(physics, "box").position.x > 4.2, `box x ${poseOf(physics, "box").position.x}`);
    const contacts = physics.syncAndPublishContacts({ step: 1, timeNs: 0 });
    assert.ok(contacts.started.includes("ego|box"));
    const speedAfterFirst = horizontalSpeed(physics, "box");
    assert.ok(speedAfterFirst > 10, `first speed ${speedAfterFirst}`);
    physics.beginStep();
    vehicle.position.x += speedAfterFirst * dt;
    physics.step(dt);
    assert.ok(horizontalSpeed(physics, "box") <= speedAfterFirst + 1, `second speed ${horizontalSpeed(physics, "box")}`);
    physics.disposeRun();

    const empty = await startPhysics(new EnvironmentDocument({ environmentId: "empty" }));
    assert.equal(Object.hasOwn(empty.getDeterministicState(), "rigidBodies"), false);
    empty.disposeRun();
});

test("the floor collider is on until the floor inspector turns it off", async () => {
    const { document, service } = yard();
    assert.equal(service.run("setFloor", { enabled: true }).ok, true);
    assert.deepEqual(document.floor, { enabled: true });
    const described = worldOf(document);
    assert.deepEqual(described.groundPlane, { id: "floor", y: 0 });
    const onHash = worldHash(document);
    const lidarOn = createLidarGeometryResource(createWorldResource(described)).hash;
    const toggled = service.run("setObjectOptions", { objectId: "floor", patch: { collider: false } });
    assert.equal(toggled.ok, true, JSON.stringify(toggled.issues));
    assert.deepEqual(document.floor, { enabled: true, collider: false });
    const off = worldOf(document);
    assert.equal(off.groundPlane.collider, false);
    assert.equal(assertWorldResource(createWorldResource(off)).groundPlane.collider, false);
    assert.notEqual(worldHash(document), onHash);
    assert.equal(createLidarGeometryResource(createWorldResource(off)).hash, lidarOn);
    assert.equal(service.run("addPrimitive", { id: "box", shape: "box", x: 0, y: 2, z: 0, size: { x: 1, y: 1, z: 1 } }).ok, true);
    assert.equal(service.run("addRigidBody", { objectId: "box" }).ok, true);
    const falling = await startPhysics(document);
    const dt = 1 / 60;
    for (let step = 0; step < 60; step += 1) falling.step(dt);
    assert.ok(poseOf(falling, "box").position.y < 0, `y ${poseOf(falling, "box").position.y}`);
    falling.disposeRun();
    assert.equal(service.bus.undo().ok, true);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(service.bus.undo().ok, true);
    assert.deepEqual(document.floor, { enabled: true });
    assert.equal(worldHash(document), onHash);
});

test("CPU LiDAR hits a moved primitive at its live pose and misses the spawn pose", () => {
    const { document, service } = yard();
    assert.equal(service.run("addPrimitive", { id: "box", shape: "box", x: 5, y: 0.5, z: 0, size: { x: 1, y: 1, z: 1 } }).ok, true);
    assert.equal(service.run("addRigidBody", { objectId: "box" }).ok, true);
    const resource = createLidarGeometryResource(createWorldResource({
        environmentId: "yard",
        templateId: "blank",
        document: document.snapshot(),
    }));
    const scene = new CpuLidarScene(resource);
    const ego = { id: "ego", position: { x: 0, y: 0.5, z: 0 }, rotation: {} };
    const horizontal = {
        id: "lidar",
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        calibration: {
            range: 30,
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
        },
    };
    const raised = {
        ...horizontal,
        calibration: {
            ...horizontal.calibration,
            elevation: { startDeg: 50, endDeg: 70, stepDeg: 2 },
        },
    };
    const sees = (buffer) => buffer.some((value, index) => index % 4 === 0 && value > 0);
    const spawned = scene.capture(horizontal, [ego]);
    assert.equal(sees(spawned), true);
    assert.equal(sees(scene.capture(raised, [ego])), false);
    const spec = worldOf(document).rigidBodies[0];
    const pose = (position) => ({
        id: spec.id,
        position,
        rotation: spec.rotation,
        spawnPosition: spec.position,
        spawnRotation: spec.rotation,
    });
    scene.setRigidBodyPoses([pose(spec.position)]);
    assert.deepEqual(scene.capture(horizontal, [ego]), spawned);
    const splitIndex = scene.staticIndex;
    scene.setRigidBodyPoses([pose({ ...spec.position, x: spec.position.x - 2 })]);
    assert.equal(scene.staticIndex, splitIndex);
    assert.equal(scene.capture(horizontal, [ego])[0], spawned[0] - 2);
    scene.setRigidBodyPoses([pose({ ...spec.position, y: spec.position.y + 8 })]);
    assert.equal(scene.staticIndex, splitIndex);
    assert.equal(sees(scene.capture(horizontal, [ego])), false);
    assert.equal(sees(scene.capture(raised, [ego])), true);
    scene.setRigidBodyPoses([pose({ ...spec.position, y: spec.position.y + 4 })]);
    assert.equal(scene.staticIndex, splitIndex);
    scene.setRigidBodyPoses([]);
    assert.notEqual(scene.staticIndex, splitIndex);
    assert.deepEqual(scene.capture(horizontal, [ego]), spawned);
    assert.equal(hashLidarGeometry(resource.description), resource.hash);
    scene.dispose();
});

test("moved rigid bodies share one index until a pose changes", () => {
    const boxes = [0, 1].map((index) => createBoxLidarTwin({
        id: `box-${index}`,
        sourceId: `box-${index}`,
        center: { x: 4 + index * 3, y: 0.5, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        tags: ["obstacle"],
        semanticId: 2,
        instanceId: 21 + index,
    }));
    const description = {
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
        staticPrimitives: [...boxes].sort((left, right) => compareUtf8(left.id, right.id)),
        actors: [],
    };
    const scene = new CpuLidarScene({ description, hash: hashLidarGeometry(description) });
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const pose = (id, x, y) => ({
        id,
        position: { x, y, z: 0 },
        rotation: identity,
        spawnPosition: { x, y: 0.5, z: 0 },
        spawnRotation: identity,
    });
    const moved = [pose("box-0", 4, 3), pose("box-1", 7, 3)];
    scene.setRigidBodyPoses(moved);
    assert.equal(scene._bodyIndex, null);
    const sensor = {
        id: "lidar",
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        calibration: {
            range: 20,
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
        },
    };
    const ego = { id: "ego", position: { x: 0, y: 0.5, z: 0 }, rotation: {} };
    scene.capture(sensor, [ego]);
    const shared = scene._bodyIndex;
    const reduced = scene.staticIndex;
    assert.ok(shared);
    assert.equal(scene._activeStaticIndex, reduced);
    scene.setRigidBodyPoses(moved.map((entry) => ({ ...entry, position: { ...entry.position } })));
    scene.capture(sensor, [ego]);
    assert.equal(scene._bodyIndex, shared);
    assert.equal(scene.staticIndex, reduced);
    scene.setRigidBodyPoses([pose("box-0", 4, 5), pose("box-1", 7, 3)]);
    scene.capture(sensor, [ego]);
    assert.notEqual(scene._bodyIndex, shared);
    assert.equal(scene.staticIndex, reduced);
    scene.dispose();
});

test("editor play sends the live rigid-body world to physics and leaves a resolved run alone", async () => {
    const calls = [];
    const holder = {
        hash: "h1",
        description: { primitives: [{ id: "box" }], rigidBodies: [{ id: "box" }] },
    };
    const physics = {
        world: null,
        preparedWorldDescription: null,
        async configureRun(config) {
            calls.push(config.worldDescription.rigidBodies.map((body) => body.id).join(","));
            this.world = {};
            this.preparedWorldDescription = config.worldDescription;
            assert.equal(config.backendSelection.capabilityId, PHYSICS_CAPABILITY_ID_V2);
        },
        disposeRun() {
            calls.push("dispose");
            this.world = null;
            this.preparedWorldDescription = null;
        },
    };
    const engine = new SimulationEngine({
        environment: () => ({
            get worldHash() { return holder.hash; },
            getWorldDescription: () => structuredClone(holder.description),
        }),
        physics: () => physics,
        bindings: () => null,
    });
    engine.syncEditorRigidBodies();
    await engine._editorPhysicsSync;
    assert.deepEqual(calls, ["box"]);
    engine.syncEditorRigidBodies();
    await engine._editorPhysicsSync;
    assert.deepEqual(calls, ["box"]);
    holder.hash = "h2";
    holder.description = { primitives: [{ id: "box" }] };
    engine.syncEditorRigidBodies();
    await engine._editorPhysicsSync;
    assert.deepEqual(calls, ["box", "dispose"]);
    holder.hash = "h3";
    holder.description = { primitives: [{ id: "box" }], rigidBodies: [{ id: "box" }] };
    engine.resolvedRun = { manifest: { id: "run" } };
    engine.syncEditorRigidBodies();
    await engine._editorPhysicsSync;
    assert.deepEqual(calls, ["box", "dispose"]);
});

test("editor reset restores rigid bodies when no run is resolved", () => {
    const calls = [];
    let poses = [{ id: "box", position: { y: 0.5 } }];
    const kernel = new SimulationKernel({
        environment: { reset() {}, getWorldDescription: () => null },
        inputs: { reset() {} },
        scripts: { reset() {} },
        physics: {
            rigidBodyPoses: () => poses,
            resetRun() {
                calls.push("reset");
                poses = [{ id: "box", position: { y: 3 } }];
            },
        },
        devices: {
            applyRigidBodyPoses(next) { calls.push(next[0].position.y); },
        },
    });
    kernel.reset();
    assert.deepEqual(calls, ["reset", 3]);
    poses = [];
    calls.length = 0;
    kernel.reset();
    assert.deepEqual(calls, []);
});

test("a sustained push matches closing speed and a side hit stays lateral", async () => {
    const dt = 1 / 60;
    const approach = 5;
    const { document, service } = yard();
    service.run("setFloor", { enabled: true });
    service.run("addPrimitive", { id: "box", shape: "box", x: 1.2, y: 0.5, z: 0, size: { x: 1, y: 1, z: 1 } });
    service.run("addRigidBody", { objectId: "box" });
    const vehicle = {
        telemetryId: "ego",
        collisionDimensions: { x: 1, y: 1, z: 1 },
        position: { x: 0, y: 0.5, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const physics = await startPhysics(document, [vehicle]);
    let maxSpeed = 0;
    for (let step = 0; step < 30; step += 1) {
        physics.beginStep();
        vehicle.position.x += approach * dt;
        physics.step(dt);
        maxSpeed = Math.max(maxSpeed, horizontalSpeed(physics, "box"));
    }
    const rested = poseOf(physics, "box");
    assert.ok(maxSpeed > 1 && maxSpeed <= approach + 0.25, `speed ${maxSpeed}`);
    assert.ok(Math.hypot(rested.position.x - 1.2, rested.position.z) < 4, `box ${rested.position.x}, ${rested.position.z}`);
    physics.disposeRun();

    const { document: sideDocument, service: side } = yard();
    side.run("addPrimitive", { id: "box", shape: "box", x: 1.2, y: 0.5, z: 0.55, size: { x: 0.6, y: 1, z: 0.6 } });
    side.run("addRigidBody", { objectId: "box" });
    side.run("setRigidBody", { objectId: "box", patch: { useGravity: false } });
    const wide = {
        telemetryId: "ego",
        collisionDimensions: { x: 3, y: 1, z: 1 },
        position: { x: 0, y: 0.5, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const lateral = await startPhysics(sideDocument, [wide]);
    lateral.beginStep();
    wide.position.x += 0.2;
    wide.position.z += 0.05;
    lateral.step(dt);
    const shifted = poseOf(lateral, "box");
    assert.ok(shifted.position.z - 0.55 > Math.abs(shifted.position.x - 1.2), `box ${shifted.position.x}, ${shifted.position.z}`);
    assert.ok(horizontalSpeed(lateral, "box") < 0.05, `speed ${horizontalSpeed(lateral, "box")}`);
    lateral.disposeRun();
});

test("a box dropped onto a raised car roof rests above it", async () => {
    const { document, service } = yard();
    service.run("setFloor", { enabled: true });
    service.run("addPrimitive", { id: "box", shape: "box", x: 0, y: 3, z: 0, size: { x: 1, y: 1, z: 1 } });
    service.run("addRigidBody", { objectId: "box" });
    const vehicle = {
        telemetryId: "ego",
        collisionDimensions: { x: 2, y: 1.4, z: 2 },
        collisionCenter: { x: 0, y: 0.7, z: 0 },
        rotation: { y: 0 },
        position: { x: 0, y: 0, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const physics = await startPhysics(document, [vehicle]);
    const dt = 1 / 60;
    for (let step = 0; step < 240; step += 1) {
        physics.beginStep();
        physics.step(dt);
    }
    const rested = poseOf(physics, "box");
    assert.ok(rested.position.y > 1.8 && rested.position.y < 2.2, `roof y ${rested.position.y}`);
    physics.disposeRun();
});

test("an overlap with a raised roof lifts the box and lets the car through", async () => {
    const { document, service } = yard();
    service.run("addPrimitive", { id: "box", shape: "box", x: 0, y: 1.2, z: 0, size: { x: 1, y: 1, z: 1 } });
    service.run("addRigidBody", { objectId: "box" });
    service.run("setRigidBody", { objectId: "box", patch: { useGravity: false } });
    const vehicle = {
        telemetryId: "ego",
        collisionDimensions: { x: 4, y: 1.4, z: 2 },
        collisionCenter: { x: 0, y: 0.7, z: 0 },
        rotation: { y: 0 },
        position: { x: 0, y: 0, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const physics = await startPhysics(document, [vehicle]);
    physics.beginStep();
    vehicle.position.x = 1;
    physics.step(1 / 60);
    const lifted = poseOf(physics, "box");
    assert.ok(lifted.position.y > 1.7, `lifted y ${lifted.position.y}`);
    assert.ok(vehicle.position.x > 0.5, `vehicle x ${vehicle.position.x}`);
    physics.disposeRun();
});

test("editor reset restores rigid bodies when the pose list is empty", () => {
    const calls = [];
    const kernel = new SimulationKernel({
        environment: { reset() {}, getWorldDescription: () => null },
        inputs: { reset() {} },
        scripts: { reset() {} },
        physics: {
            rigidBodyPoses: () => [],
            preparedWorldDescription: { rigidBodies: [{ id: "box" }] },
            resetRun() { calls.push("reset"); },
        },
        devices: {
            applyRigidBodyPoses() { calls.push("poses"); },
        },
    });
    kernel.reset();
    assert.deepEqual(calls, ["reset", "poses"]);
});

test("editor play from stopped restores rigid bodies and pause does not", () => {
    const calls = [];
    const mesh = {
        position: { set(x, y, z) { this.xyz = [x, y, z]; } },
        quaternion: { set() {} },
        updateMatrixWorld() {},
    };
    const physics = {
        world: {},
        preparedWorldDescription: { rigidBodies: [{ id: "box" }] },
        rigidBodyPoses: () => [{
            id: "box",
            host: "primitive",
            position: { x: 1, y: 2, z: 3 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
        }],
        resetRun() { calls.push("reset"); },
    };
    const engine = new SimulationEngine({
        environment: () => ({ worldHash: "h", getWorldDescription: () => ({ rigidBodies: [{ id: "box" }] }) }),
        physics: () => physics,
        bindings: () => null,
        scene: { getObjectByName(name) { return name === "primitive:box" ? mesh : null; } },
    });
    engine.restoreStoppedEditorBodies();
    assert.deepEqual(calls, ["reset"]);
    assert.deepEqual(mesh.position.xyz, [1, 2, 3]);
    calls.length = 0;
    engine.status = "paused";
    engine.restoreStoppedEditorBodies();
    assert.deepEqual(calls, []);
    engine.status = "stopped";
    engine.resolvedRun = { manifest: { id: "run" } };
    engine.restoreStoppedEditorBodies();
    assert.deepEqual(calls, []);
});
