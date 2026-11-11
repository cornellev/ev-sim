import assert from "node:assert/strict";
import test from "node:test";
import { Euler, Quaternion } from "three";

import { BrowserCpuLidarRuntime } from "../app/3d/devices/BrowserCpuLidarRuntime.js";
import {
    createBoxLidarTwin,
    createTriangleLidarTwin,
    hashLidarGeometry,
} from "../app/simulation/lidar/LidarGeometry.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { CpuLidarWorkerService } from "../app/simulation/sensors/CpuLidarWorkerService.js";
import { compareUtf8 } from "../app/simulation/world/WorldDescription.js";
import { rigidBodyPoseMoved, transformRigidBodyPoint } from "../app/simulation/world/RigidBodyRecords.js";
import { createCpuLidarTestWorker } from "./helpers/cpuLidarWorker.js";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const VEHICLES = [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }];
const SENSOR = {
    id: "lidar", parentId: "ego", pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
    calibration: {
        range: 200,
        azimuth: { startDeg: 0, endDeg: 360, stepDeg: 5 },
        elevation: { startDeg: -20, endDeg: 25, stepDeg: 5 },
    },
};
const SINGLE_RAY = { ...SENSOR, calibration: {
    range: 200,
    azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
    elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
} };

function resource(primitives) {
    const description = {
        kind: "cev-sim.lidar-geometry", version: 1,
        coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
        staticPrimitives: [...primitives].sort((a, b) => compareUtf8(a.id, b.id)),
        actors: [],
    };
    return { description, hash: hashLidarGeometry(description) };
}

function pose(id, position = { x: 0, y: 0, z: 0 }, rotation = IDENTITY) {
    return {
        id, position: { ...position }, rotation: { ...rotation },
        spawnPosition: { x: 0, y: 0, z: 0 }, spawnRotation: { ...IDENTITY },
    };
}

function box(id, x = 5, z = 0, instanceId = 1) {
    return createBoxLidarTwin({
        id, sourceId: id, center: { x, y: 0, z }, size: { x: 2, y: 2, z: 2 },
        semanticId: 2, instanceId,
    });
}

function quaternion(x, y, z) {
    const q = new Quaternion().setFromEuler(new Euler(x, y, z));
    return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function bake(primitives, poses) {
    const byId = new Map(poses.map((entry) => [entry.id, entry]));
    return primitives.map((primitive) => {
        const current = byId.get(primitive.sourceId);
        if (!rigidBodyPoseMoved(current)) return primitive;
        return primitive.shape === "box"
            ? { ...primitive, center: transformRigidBodyPoint(primitive.center, current) }
            : { ...primitive, vertices: primitive.vertices.map((vertex) => transformRigidBodyPoint(vertex, current)) };
    });
}

function freshCapture(primitives, poses, config = SENSOR, vehicles = VEHICLES) {
    const scene = new CpuLidarScene(resource(bake(primitives, poses)));
    try { return scene.capture(config, vehicles); }
    finally { scene.dispose(); }
}

function assertBytes(actual, expected) {
    assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
}

function watchCoordinates(index) {
    const writes = new Set();
    const normalWrites = new Set();
    const positions = index.geometry.attributes.position;
    positions.array = new Proxy(positions.array, {
        get(target, key) {
            if (key === "set") return (values, offset = 0) => {
                for (let i = offset; i < offset + values.length; i += 1) writes.add(i);
                target.set(values, offset);
            };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, key, value) {
            writes.add(Number(key));
            return Reflect.set(target, key, value, target);
        },
    });
    for (const [faceIndex, face] of index.faces.entries()) {
        face.normal = new Proxy(face.normal, {
            set(target, key, value) {
                normalWrites.add(faceIndex);
                return Reflect.set(target, key, value, target);
            },
        });
    }
    return { writes, normalWrites };
}

test("spawn and unchanged CPU captures perform no body coordinate writes or refits", (t) => {
    const primitives = [box("a"), box("b", 20, 0, 2)];
    const scene = new CpuLidarScene(resource(primitives));
    t.after(() => scene.dispose());
    const full = scene.fullStaticIndex;
    const original = scene.capture(SINGLE_RAY, VEHICLES);
    scene.setRigidBodyPoses([pose("a"), pose("b")]);
    for (let i = 0; i < 3; i += 1) assertBytes(scene.capture(SINGLE_RAY, VEHICLES), original);
    assert.equal(scene._bodyIndex, null);
    assert.equal(scene._activeStaticIndex, full);

    const moved = [pose("a", { x: 2, y: 0, z: 0 }), pose("b")];
    scene.setRigidBodyPoses(moved);
    const captured = scene.capture(SINGLE_RAY, VEHICLES);
    const index = scene._bodyIndex;
    const { writes, normalWrites } = watchCoordinates(index);
    const refit = t.mock.method(index.bvh, "refit");
    const version = index.geometry.attributes.position.version;
    const snapshot = scene._poseTracker.get("a");
    for (let i = 0; i < 3; i += 1) {
        scene.setRigidBodyPoses(structuredClone(moved).reverse());
        assertBytes(scene.capture(SINGLE_RAY, VEHICLES), captured);
    }
    assert.equal(scene._poseTracker.get("a"), snapshot);
    assert.equal(scene._bodyIndex, index);
    assert.equal(scene.fullStaticIndex, full);
    assert.equal(writes.size, 0);
    assert.equal(normalWrites.size, 0);
    assert.equal(refit.mock.callCount(), 0);
    assert.equal(index.geometry.attributes.position.version, version);
});

test("one body's motion writes its ranges and selectively refits cached leaves and ancestors", (t) => {
    // Geometry order differs from spatial order, exercising indirect triangle resolution.
    const primitives = Array.from({ length: 16 }, (_, i) => box(`body-${i}`, 5 + (i * 7 % 16) * 5, 0, i + 1));
    const scene = new CpuLidarScene(resource(primitives));
    t.after(() => scene.dispose());
    const poses = primitives.map((primitive) => pose(primitive.id, { x: 1, y: 0, z: 0 }));
    scene.setRigidBodyPoses(poses);
    scene.capture(SINGLE_RAY, VEHICLES);
    const index = scene._bodyIndex;
    const reduced = scene.staticIndex;
    const position = index.geometry.attributes.position;
    const initial = position.array.slice();
    const body = index.bodies.get("body-0");
    const cachedNodes = body.nodeIndices;
    const allNodes = new Set();
    const expectedNodes = new Set();
    const ancestors = [0];
    const expectedFaces = new Set(body.ranges.flatMap(({ offset, end }) => (
        Array.from({ length: (end - offset) / 9 }, (_, i) => offset / 9 + i)
    )));
    index.bvh.shapecast({
        intersectsBounds(_box, _leaf, _score, depth, node) { ancestors[depth] = node; allNodes.add(node); return true; },
        intersectsRange(offset, count, _contained, depth, node) {
            allNodes.add(node);
            for (let i = offset; i < offset + count; i += 1) {
                if (!expectedFaces.has(index.bvh.resolveTriangleIndex(i))) continue;
                expectedNodes.add(node);
                for (let level = 0; level < depth; level += 1) expectedNodes.add(ancestors[level]);
            }
            return false;
        },
    });
    assert.deepEqual(cachedNodes, expectedNodes);
    assert.ok(cachedNodes.size < allNodes.size);
    assert.ok(Array.from({ length: index.faces.length }, (_, i) => index.bvh.resolveTriangleIndex(i)).some((face, i) => face !== i));

    const { writes, normalWrites } = watchCoordinates(index);
    const refits = [];
    const originalRefit = index.bvh.refit.bind(index.bvh);
    t.mock.method(index.bvh, "refit", (nodes) => { refits.push(new Set(nodes)); return originalRefit(nodes); });
    poses[0].position = { x: -3.123456789, y: 0.0123456789, z: 0.23456789 };
    scene.setRigidBodyPoses(poses);
    const shapecast = t.mock.method(index.bvh, "shapecast");
    const actual = scene.capture(SINGLE_RAY, VEHICLES);
    assertBytes(actual, freshCapture(primitives, poses, SINGLE_RAY));
    assert.equal(shapecast.mock.callCount(), 1, "only the combined body query runs per ray");
    assert.equal(scene._bodyIndex, index);
    assert.equal(scene.staticIndex, reduced);
    assert.equal(body.nodeIndices, cachedNodes);
    assert.deepEqual(refits, [cachedNodes]);
    const expectedWrites = new Set(body.ranges.flatMap(({ offset, end }) => (
        Array.from({ length: end - offset }, (_, i) => offset + i)
    )));
    assert.deepEqual(writes, expectedWrites);
    assert.deepEqual(normalWrites, expectedFaces);
    for (let i = 0; i < initial.length; i += 1) if (!writes.has(i)) assert.equal(position.array[i], initial[i]);
});

test("return to spawn restores original coordinates and normals without rebuilding", (t) => {
    const primitives = [box("a"), box("b", 20, 0, 2)];
    const scene = new CpuLidarScene(resource(primitives));
    t.after(() => scene.dispose());
    const spawned = scene.capture(SENSOR, VEHICLES);
    scene.setRigidBodyPoses([pose("a", { x: 2, y: 3, z: -1 }), pose("b")]);
    scene.capture(SENSOR, VEHICLES);
    const index = scene._bodyIndex;
    const refit = t.mock.method(index.bvh, "refit");
    scene.setRigidBodyPoses([pose("a"), pose("b")]);
    assertBytes(scene.capture(SENSOR, VEHICLES), spawned);
    assert.equal(scene._activeStaticIndex, scene.fullStaticIndex);
    assert.equal(scene._queryBodyIndex, null);
    assert.equal(scene._bodyIndex, index);
    assert.deepEqual(index.geometry.attributes.position.array, new Float32Array(index.originalPositions));
    assert.deepEqual(index.faces.flatMap(({ normal }) => [normal.x, normal.y, normal.z]), [...index.originalNormals]);
    assert.equal(refit.mock.callCount(), 1);
    scene.capture(SENSOR, VEHICLES);
    assert.equal(refit.mock.callCount(), 1);
    scene.setRigidBodyPoses([pose("a", { x: -2, y: 0, z: 0 }), pose("b")]);
    assertBytes(scene.capture(SENSOR, VEHICLES), freshCapture(primitives, [pose("a", { x: -2, y: 0, z: 0 }), pose("b")]));
    assert.equal(scene._bodyIndex, index);
});

test("membership removals and re-enable rebuild only the split and keep authored geometry", (t) => {
    const primitives = [box("a"), box("b", 20, 0, 2)];
    const scene = new CpuLidarScene(resource(primitives));
    t.after(() => scene.dispose());
    const full = scene.fullStaticIndex;
    const a = pose("a", { x: 2, y: 0, z: 0 });
    const b = pose("b", { x: -3, y: 0, z: 0 });
    scene.setRigidBodyPoses([a, b]);
    scene.capture(SENSOR, VEHICLES);
    const previous = scene._bodyIndex;
    const disposed = t.mock.method(previous.geometry, "dispose");
    scene.setRigidBodyPoses([b]);
    assert.equal(scene._bodyIndex, null);
    assert.equal(disposed.mock.callCount(), 1);
    assertBytes(scene.capture(SENSOR, VEHICLES), freshCapture(primitives, [b]));
    assert.notEqual(scene._bodyIndex, previous);
    assert.equal(scene._poseTracker.get("a"), null);
    scene.setRigidBodyPoses([]);
    assertBytes(scene.capture(SENSOR, VEHICLES), freshCapture(primitives, []));
    assert.equal(scene.staticIndex, full);
    assert.equal(scene._bodyIndex, null);
    scene.setRigidBodyPoses([a, b]);
    assertBytes(scene.capture(SENSOR, VEHICLES), freshCapture(primitives, [a, b]));
    assert.equal(scene.fullStaticIndex, full);
    scene.setRigidBodyPoses([pose("unknown", { x: 1, y: 0, z: 0 })]);
    assertBytes(scene.capture(SENSOR, VEHICLES), freshCapture(primitives, []));
    assert.equal(scene._bodyIndex, null);
});

test("CPU poses are immutable snapshots and same-object edits are detected on resync", (t) => {
    const primitives = [box("a")];
    const geometry = resource(primitives);
    const before = structuredClone(geometry);
    const scene = new CpuLidarScene(geometry);
    t.after(() => scene.dispose());
    const input = pose("a", { x: 2, y: 0, z: 0 });
    const first = structuredClone(input);
    scene.setRigidBodyPoses([input]);
    const snapshot = scene._poseTracker.get("a");
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.position) && Object.isFrozen(snapshot.rotation));
    input.position.x = 4;
    input.spawnPosition.z = 0.4;
    input.spawnRotation.y = 0.1;
    assertBytes(scene.capture(SENSOR, VEHICLES), freshCapture(primitives, [first]));
    const index = scene._bodyIndex;
    scene.setRigidBodyPoses([input]);
    assertBytes(scene.capture(SENSOR, VEHICLES), freshCapture(primitives, [input]));
    assert.equal(scene._bodyIndex, index);
    assert.deepEqual(geometry, before);
    assert.equal(hashLidarGeometry(geometry.description), geometry.hash);
});

test("incremental mixed-shape scans match fresh bakes byte-for-byte across rotations and frames", (t) => {
    const triangle = (id, sourceId, vertices, instanceId) => createTriangleLidarTwin({
        id, sourceId, vertices, semanticId: 3, instanceId, triangleIndex: 7,
    });
    const primitives = [
        box("legacy", 7.123456, -3.345678, 1),
        triangle("flag", "flag", [{ x: 5.123456, y: -2.234567, z: -2.345678 }, { x: 6.345678, y: 3.456789, z: -1.456789 }, { x: 5.567891, y: 0.678912, z: 2.789123 }], 2),
        triangle("compound:a", "compound", [{ x: -8.123456, y: -2, z: 2 }, { x: -7.234567, y: 2, z: 2 }, { x: -8.345678, y: 1, z: 6 }], 3),
        triangle("compound:z", "compound", [{ x: -8.123456, y: -2, z: 2 }, { x: -8.345678, y: 1, z: 6 }, { x: -9.456789, y: -1, z: 4 }], 3),
        box("static", 30, 20, 4),
    ];
    const geometry = resource(primitives);
    const original = structuredClone(geometry);
    const scene = new CpuLidarScene(geometry);
    t.after(() => scene.dispose());
    let retained = null;
    const explicit = { ...SENSOR, calibration: { scanLayout: {
        channels: [0, -10, 15].map((elevationDeg) => ({ elevationDeg, azimuthOffsetDeg: 2.25 })),
        azimuthsDeg: [90, 0, -90, 180, ...Array.from({ length: 72 }, (_, i) => i * 5)],
        minRangeM: 0.0001, maxRangeM: 200,
    } } };
    let hitCount = 0;
    for (let frame = 0; frame < 8; frame += 1) {
        const poses = [pose("legacy"), pose("flag"), pose("compound")];
        if (frame !== 0 && frame !== 6) for (const [i, entry] of poses.entries()) {
            entry.position = { x: frame * 0.234567891, y: i * 0.123456789, z: -frame * 0.345678912 };
            entry.rotation = quaternion(frame * 0.017, frame * 0.183, i * 0.023);
            entry.spawnPosition = { x: 0.123456789, y: -0.234567891, z: 0.345678912 };
            entry.spawnRotation = quaternion(0.011, -0.127, 0.013);
        }
        scene.setRigidBodyPoses(poses.reverse());
        for (const config of [SENSOR, explicit]) {
            const actual = scene.capture(config, VEHICLES);
            assertBytes(actual, freshCapture(primitives, poses, config));
            hitCount += actual.filter((value, i) => i % 4 === 0 && value > 0).length;
        }
        if (scene._bodyIndex) {
            if (retained) assert.equal(scene._bodyIndex, retained);
            retained = scene._bodyIndex;
            const fresh = new CpuLidarScene(resource(bake(primitives.filter((p) => p.sourceId !== "static"), poses)));
            try {
                assert.deepEqual(retained.faces.map(({ normal }) => normal.toArray()), fresh.fullStaticIndex.faces.map(({ normal }) => normal.toArray()));
            } finally { fresh.dispose(); }
        }
    }
    assert.ok(hitCount > 50, "parity exercises actual hits");
    assert.deepEqual(geometry, original);
});

test("CPU worker consumes full pose snapshots, retains motion identity, and fences generations", (t) => {
    const primitives = [box("a"), box("b", 20, 0, 2)];
    const worker = new CpuLidarWorkerService();
    t.after(() => worker.dispose());
    worker.handle("prepare", { resolvedRun: { lidarGeometry: resource(primitives) }, sensors: [SENSOR], generation: 0 });
    const capture = (rigidBodyPoses, generation = 0) => worker.handle("capture", {
        sensorId: SENSOR.id, vehicles: VEHICLES, rigidBodyPoses, generation,
    }).buffer;
    const a = pose("a", { x: 2, y: 0, z: 0 });
    const b = pose("b", { x: -2, y: 0, z: 0 });
    assertBytes(capture([a, b]), freshCapture(primitives, [a, b]));
    const index = worker.scene._bodyIndex;
    const refit = t.mock.method(index.bvh, "refit");
    capture(structuredClone([a, b]));
    assert.equal(refit.mock.callCount(), 0);
    a.position.x = 4;
    assertBytes(capture([a, b]), freshCapture(primitives, [a, b]));
    assert.equal(worker.scene._bodyIndex, index);
    assert.equal(refit.mock.callCount(), 1);
    assertBytes(capture([b]), freshCapture(primitives, [b]));
    assert.equal(worker.scene._poseTracker.get("a"), null);
    assertBytes(capture(undefined, 1), freshCapture(primitives, []));
    assert.equal(worker.scene._bodyIndex, null);
    assert.throws(() => capture([a], 0), /Stale CPU LiDAR generation/);
    assert.throws(() => worker.handle("digest", { generation: 0 }), /Stale CPU LiDAR generation/);
    assert.throws(() => worker.handle("digest", { generation: 2 }), /Stale CPU LiDAR digest/);
    assertBytes(capture([a, b], 1), freshCapture(primitives, [a, b]));
});

test("browser inline and worker snapshots survive caller mutation and reset/removal/re-enable", async (t) => {
    const primitives = [box("a")];
    const resolved = { lidarGeometry: resource(primitives) };
    for (const implementation of ["inline", "worker"]) {
        const worker = implementation === "worker" ? createCpuLidarTestWorker() : null;
        const runtime = new BrowserCpuLidarRuntime({ workerFactory: () => worker });
        t.after(() => runtime.dispose());
        await runtime.prepare(resolved, [SENSOR]);
        const input = pose("a", { x: 2, y: 0, z: 0 });
        runtime.setRigidBodyPoses([input]);
        const snapshot = runtime.rigidBodyPoses;
        runtime.setRigidBodyPoses([structuredClone(input)]);
        assert.equal(runtime.rigidBodyPoses, snapshot);
        input.position.x = 8;
        assertBytes(await runtime.capture(SENSOR, VEHICLES), freshCapture(primitives, [pose("a", { x: 2, y: 0, z: 0 })]));
        runtime.setEpisodePrimitives([]);
        assertBytes(await runtime.capture(SENSOR, VEHICLES), freshCapture(primitives, []));
        runtime.setRigidBodyPoses([input]);
        assertBytes(await runtime.capture(SENSOR, VEHICLES), freshCapture(primitives, [input]));
        runtime.setRigidBodyPoses([]);
        assertBytes(await runtime.capture(SENSOR, VEHICLES), freshCapture(primitives, []));
        if (worker) {
            worker.hold = true;
            runtime.setRigidBodyPoses([input]);
            const stale = runtime.capture(SENSOR, VEHICLES);
            runtime.setEpisodePrimitives([]);
            await assert.rejects(stale, { code: "CPU_LIDAR_CANCELLED" });
            input.position.x = 3;
            runtime.setRigidBodyPoses([input]);
            const queued = runtime.capture(SENSOR, VEHICLES);
            input.position.x = 12;
            worker.flush();
            assertBytes(await queued, freshCapture(primitives, [pose("a", { x: 3, y: 0, z: 0 })]));
        }
        runtime.dispose();
    }
});
