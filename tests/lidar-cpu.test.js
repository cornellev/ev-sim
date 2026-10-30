import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { rep103PoseToThree } from "../app/autonomy/CoordinateFrames.js";
import {
    createBoxLidarTwin,
    createTriangleLidarTwin,
    hashLidarGeometry,
    LIDAR_GEOMETRY_KIND,
    LIDAR_GEOMETRY_VERSION,
} from "../app/simulation/lidar/LidarGeometry.js";
import { CPU_LIDAR_NEAR_METERS, CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { compareUtf8 } from "../app/simulation/world/WorldDescription.js";
import { transformRigidBodyPoint } from "../app/simulation/world/RigidBodyRecords.js";
import {
    DoubleSide,
    Euler,
    Matrix4,
    Quaternion,
    Ray,
    Vector3,
} from "three";

function resource(staticPrimitives = [], actors = [], planes = undefined) {
    const description = {
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
        staticPrimitives: [...staticPrimitives].sort((left, right) => compareUtf8(left.id, right.id)),
        actors: [...actors].sort((left, right) => compareUtf8(left.actorId, right.actorId)),
        ...(planes ? { planes } : {}),
    };
    return { description, hash: hashLidarGeometry(description) };
}

function sensor(overrides = {}) {
    return {
        id: "lidar", parentId: "ego", pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        calibration: {
            range: 20,
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
        },
        ...overrides,
    };
}

const ego = { id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} };

test("episode triangle ties use triangle index even when authored order differs", () => {
    const scene = new CpuLidarScene(resource());
    const triangle = (triangleIndex, semanticId) => createTriangleLidarTwin({
        id: "episode", sourceId: "episode", triangleIndex, semanticId, instanceId: 1,
        vertices: [{ x: 5, y: -2, z: -2 }, { x: 5, y: 2, z: -2 }, { x: 5, y: 0, z: 2 }],
    });
    scene.setEpisodePrimitives([triangle(7, 7), triangle(2, 2)]);
    assert.deepEqual(Array.from(scene.capture(sensor(), [ego])), [5, 1, 2, 1]);
    scene.dispose();
});

test("single traversal is byte-identical to all-hits for varied poses, UTF-8 ties, edges, and range boundaries", () => {
    const primitives = ["z", "é", "😀", "a"].map((id, index) => createBoxLidarTwin({
        id, sourceId: id, center: { x: 5, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 },
        semanticId: index, instanceId: index + 1,
    }));
    for (let index = 0; index < 40; index += 1) primitives.push(createBoxLidarTwin({
        id: `box-${index}`, sourceId: `box-${index}`, center: { x: (index % 8) * 4 - 16, y: index % 3, z: Math.floor(index / 8) * 4 - 8 },
        size: { x: 1, y: 2, z: 2 }, instanceId: index + 100,
    }));
    const scene = new CpuLidarScene(resource(primitives));
    try {
        for (const near of [0.0001, 4, 4.000001]) for (const far of [4, 4.000001, 80]) {
            if (far < near) continue;
            const channels = [-45, 0, 30].map((elevationDeg) => ({ elevationDeg, azimuthOffsetDeg: 0 }));
            const azimuthsDeg = Array.from({ length: 72 }, (_, index) => index * 5);
            const config = sensor({ calibration: { scanLayout: { channels, azimuthsDeg, minRangeM: near, maxRangeM: far } } });
            for (const yaw of [0, 0.1, -0.7]) {
                const vehicles = [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: { y: yaw } }];
                const actual = scene.capture(config, vehicles);
                const expected = legacyCapture(scene, config, vehicles, near, far, {
                    width: azimuthsDeg.length, height: channels.length,
                    at(row, column) { return { phi: channels[row].elevationDeg * Math.PI / 180, theta: azimuthsDeg[column] * Math.PI / 180 }; },
                });
                assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
            }
        }
    } finally { scene.dispose(); }
});

test("CPU BVH LiDAR resolves nearest deterministic labels and all-zero no-hit sentinels", () => {
    const far = createTriangleLidarTwin({
        id: "z-far", sourceId: "far", vertices: [{ x: 8, y: -2, z: -2 }, { x: 8, y: 2, z: -2 }, { x: 8, y: 0, z: 2 }],
        tags: ["road"], semanticId: 4, instanceId: 80,
    });
    const tieB = createTriangleLidarTwin({
        id: "b-wall", sourceId: "b", vertices: [{ x: 5, y: -2, z: -2 }, { x: 5, y: 2, z: -2 }, { x: 5, y: 0, z: 2 }],
        tags: ["vehicle"], semanticId: 3, instanceId: 12,
    });
    const tieA = createTriangleLidarTwin({
        id: "a-wall", sourceId: "a", vertices: [{ x: 5, y: -2, z: -2 }, { x: 5, y: 2, z: -2 }, { x: 5, y: 0, z: 2 }],
        tags: ["building"], semanticId: 1, instanceId: 11,
    });
    const scene = new CpuLidarScene(resource([far, tieB, tieA]));
    assert.deepEqual(Array.from(scene.capture(sensor(), [ego])), [5, 1, 1, 11]);
    const miss = scene.capture(sensor({
        calibration: { range: 4.99, azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 }, elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 } },
    }), [ego]);
    assert.deepEqual(Array.from(miss), [0, 0, 0, 0]);
    scene.dispose();
    assert.throws(() => scene.capture(sensor(), [ego]), /disposed/);
});

test("actor-local BVHs move by transform, exclude the parent, and replay without rebuild", () => {
    const targetPrimitive = createBoxLidarTwin({
        id: "target-box", sourceId: "target", ownerActorId: "target", frame: "actor-local",
        center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, tags: ["vehicle"], semanticId: 3, instanceId: 31,
    });
    const egoPrimitive = createBoxLidarTwin({
        id: "ego-box", sourceId: "ego", ownerActorId: "ego", frame: "actor-local",
        center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 }, tags: ["vehicle"], semanticId: 3, instanceId: 32,
    });
    const scene = new CpuLidarScene(resource([], [
        { actorId: "ego", primitives: [egoPrimitive] },
        { actorId: "target", primitives: [targetPrimitive] },
    ]));
    const target = { id: "target", position: { x: 5, y: 0, z: 0 }, rotation: {} };
    assert.deepEqual(Array.from(scene.capture(sensor(), [ego, target])), [4, 1, 3, 31]);
    target.position.x = 8;
    assert.deepEqual(Array.from(scene.capture(sensor(), [ego, target])), [7, 1, 3, 31]);
    target.position.x = 5;
    assert.deepEqual(Array.from(scene.capture(sensor(), [ego, target])), [4, 1, 3, 31]);
    assert.deepEqual(Array.from(scene.capture(sensor(), [ego])), [0, 0, 0, 0]);
    scene.dispose();
});

test("explicit range-image layouts preserve authored channel order and azimuth corrections", () => {
    const targets = [
        createBoxLidarTwin({
            id: "positive-x", sourceId: "positive-x",
            center: { x: 5, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
            semanticId: 1, instanceId: 11,
        }),
        createBoxLidarTwin({
            id: "positive-z", sourceId: "positive-z",
            center: { x: 0, y: 0, z: 7 }, size: { x: 1, y: 1, z: 1 },
            semanticId: 2, instanceId: 22,
        }),
        createBoxLidarTwin({
            id: "negative-x", sourceId: "negative-x",
            center: { x: -9, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
            semanticId: 3, instanceId: 33,
        }),
    ];
    const scene = new CpuLidarScene(resource(targets));
    const buffer = scene.capture(sensor({
        calibration: {
            scanLayout: {
                kind: "cev-sim.range-image-layout",
                version: 1,
                channels: [
                    { id: 10, elevationDeg: 0, azimuthOffsetDeg: 0 },
                    { id: 20, elevationDeg: 0, azimuthOffsetDeg: 90 },
                ],
                azimuthsDeg: [0, 90],
                minRangeM: 0.1,
                maxRangeM: 20,
            },
        },
    }), [ego]);
    assert.deepEqual(
        [0, 1, 2, 3].map((ray) => [buffer[ray * 4], buffer[ray * 4 + 2], buffer[ray * 4 + 3]]),
        [
            [4.5, 1, 11],
            [6.5, 2, 22],
            [6.5, 2, 22],
            [8.5, 3, 33],
        ],
    );
    scene.dispose();
});

test("CPU output matches the committed browser GLSL simple-scene reference", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/headless/lidar-gpu-reference.v1.json", import.meta.url), "utf8"));
    const primitive = createBoxLidarTwin({ ...fixture.box, tags: ["building"] });
    const scene = new CpuLidarScene(resource([primitive]));
    const buffer = scene.capture(sensor({ calibration: fixture.sensor }), [ego]);
    for (const expected of fixture.rays) {
        const offset = expected.rayIndex * 4;
        const hit = buffer[offset] > 0 && buffer[offset + 3] > 0;
        assert.equal(hit, expected.hit);
        assert.equal(buffer[offset + 2], expected.semanticId);
        assert.equal(buffer[offset + 3], expected.instanceId);
        const distanceTolerance = Math.max(1e-4, 1e-5 * expected.distance);
        assert.ok(Math.abs(buffer[offset] - expected.distance) <= distanceTolerance);
        assert.ok(Math.abs(buffer[offset + 1] - expected.incidence) <= 1e-4);
    }
    scene.dispose();
});

function legacyVehicleMatrix(vehicle) {
    const rotation = vehicle.rotation ?? {};
    return new Matrix4().compose(
        new Vector3(vehicle.position.x, vehicle.position.y, vehicle.position.z),
        new Quaternion().setFromEuler(new Euler(
            Number(rotation.x) || 0,
            Number(rotation.y) || 0,
            Number(rotation.z) || 0,
            rotation.order || "XYZ",
        )),
        new Vector3(1, 1, 1),
    );
}

function legacySensorMatrix(vehicle, pose) {
    const converted = rep103PoseToThree(pose);
    const local = new Matrix4().compose(
        new Vector3(converted.position.x, converted.position.y, converted.position.z),
        new Quaternion().setFromEuler(new Euler(
            converted.rotation.x,
            converted.rotation.y,
            converted.rotation.z,
            converted.rotation.order || "XYZ",
        )),
        new Vector3(1, 1, 1),
    );
    return legacyVehicleMatrix(vehicle).multiply(local);
}

function legacyHitOrder(left, right) {
    return left.distance - right.distance
        || compareUtf8(left.primitiveId, right.primitiveId)
        || left.triangleIndex - right.triangleIndex;
}

function legacyIndexHits(index, ray, near, far) {
    if (!index) return [];
    return index.bvh.raycast(ray, DoubleSide, near, far).flatMap((hit) => {
        const metadata = index.faces[hit.faceIndex];
        if (hit.distance < near || hit.distance > far) return [];
        return [{
            primitiveId: metadata.primitiveId,
            triangleIndex: metadata.triangleIndex,
            semanticId: metadata.semanticId,
            instanceId: metadata.instanceId,
            distance: hit.distance,
            incidence: Math.abs(metadata.normal.clone().dot(ray.direction)),
        }];
    });
}

function legacyPlaneHits(planes, ray, near, far) {
    const hits = [];
    for (const plane of planes ?? []) {
        const denom = ray.direction.y;
        if (Math.abs(denom) <= 1e-7) continue;
        const distance = (plane.y - ray.origin.y) / denom;
        if (distance < near || distance > far) continue;
        hits.push({
            primitiveId: plane.id,
            triangleIndex: 0,
            semanticId: plane.semanticId,
            instanceId: plane.instanceId,
            distance,
            incidence: Math.abs(denom),
        });
    }
    return hits;
}

function legacyCapture(scene, config, vehicles, near, far, directionAt) {
    const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === config.parentId);
    const matrix = legacySensorMatrix(vehicle, config.pose);
    const origin = new Vector3().setFromMatrixPosition(matrix);
    const sensorQuaternion = new Quaternion().setFromRotationMatrix(matrix);
    const width = directionAt.width;
    const height = directionAt.height;
    const buffer = new Float32Array(width * height * 4);
    const worldRay = new Ray(origin, new Vector3());
    for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
            const { phi, theta } = directionAt.at(row, column);
            const cosPhi = Math.cos(phi);
            worldRay.direction.set(
                cosPhi * Math.cos(theta),
                Math.sin(phi),
                cosPhi * Math.sin(theta),
            ).applyQuaternion(sensorQuaternion).normalize();
            const candidates = [
                ...legacyIndexHits(scene.staticIndex, worldRay, near, far),
                ...legacyIndexHits(scene.episodeIndex, worldRay, near, far),
                ...legacyPlaneHits(scene.planes, worldRay, near, far),
            ];
            for (const [actorId, index] of scene.actorIndexes) {
                if (actorId === config.parentId || !index) continue;
                const actor = vehicles.find((entry) => (entry.telemetryId || entry.id) === actorId);
                if (!actor) continue;
                const localRay = worldRay.clone().applyMatrix4(legacyVehicleMatrix(actor).clone().invert());
                candidates.push(...legacyIndexHits(index, localRay, near, far));
            }
            const hit = candidates.sort(legacyHitOrder)[0];
            if (!hit) continue;
            const offset = (row * width + column) * 4;
            buffer[offset] = hit.distance;
            buffer[offset + 1] = hit.incidence;
            buffer[offset + 2] = hit.semanticId;
            buffer[offset + 3] = hit.instanceId;
        }
    }
    return buffer;
}

test("nearest-hit capture matches an all-hits reference for ties, actors, and the floor", () => {
    const shared = { y: 1, z: 0 };
    const staticBoxes = [
        createBoxLidarTwin({
            id: "face-b", sourceId: "face-b", center: { ...shared, x: 6 }, size: { x: 1, y: 2, z: 2 },
            tags: ["vehicle"], semanticId: 3, instanceId: 12,
        }),
        createBoxLidarTwin({
            id: "face-a", sourceId: "face-a", center: { ...shared, x: 6 }, size: { x: 1, y: 2, z: 2 },
            tags: ["building"], semanticId: 1, instanceId: 11,
        }),
        createBoxLidarTwin({
            id: "edge-neighbor", sourceId: "edge-neighbor", center: { ...shared, x: 7 }, size: { x: 1, y: 2, z: 2 },
            tags: ["building"], semanticId: 1, instanceId: 13,
        }),
    ];
    const target = createBoxLidarTwin({
        id: "target-box", sourceId: "target", ownerActorId: "target", frame: "actor-local",
        center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
        tags: ["vehicle"], semanticId: 3, instanceId: 31,
    });
    const egoBox = createBoxLidarTwin({
        id: "ego-box", sourceId: "ego", ownerActorId: "ego", frame: "actor-local",
        center: { x: 0.5, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
        tags: ["vehicle"], semanticId: 3, instanceId: 32,
    });
    const scene = new CpuLidarScene(resource(staticBoxes, [
        { actorId: "ego", primitives: [egoBox] },
        { actorId: "target", primitives: [target] },
    ], [{
        id: "lidar:floor",
        sourceId: "floor",
        shape: "plane",
        y: 0,
        semanticId: 0,
        instanceId: 900001,
    }]));
    const grid = sensor({
        calibration: {
            range: 30,
            azimuth: { startDeg: 0, endDeg: 180, stepDeg: 90 },
            elevation: { startDeg: -45, endDeg: 45, stepDeg: 45 },
        },
    });
    const layout = sensor({
        calibration: {
            scanLayout: {
                kind: "cev-sim.range-image-layout",
                version: 1,
                channels: [
                    { id: 10, elevationDeg: 0, azimuthOffsetDeg: 0 },
                    { id: 20, elevationDeg: -45, azimuthOffsetDeg: 0 },
                ],
                azimuthsDeg: [0, 90],
                minRangeM: 0.1,
                maxRangeM: 30,
            },
        },
    });
    const vehicles = [
        { id: "ego", position: { x: 0, y: 1, z: 0 }, rotation: {} },
        { id: "target", position: { x: 0, y: 1, z: 5 }, rotation: {} },
    ];
    const gridDirections = {
        width: 2,
        height: 2,
        at(row, column) {
            return {
                phi: (-45 + row * 45) * Math.PI / 180,
                theta: column * 90 * Math.PI / 180,
            };
        },
    };
    const layoutDirections = {
        width: 2,
        height: 2,
        at(row, column) {
            return {
                phi: (row === 0 ? 0 : -45) * Math.PI / 180,
                theta: column * 90 * Math.PI / 180,
            };
        },
    };
    const gridBuffer = scene.capture(grid, vehicles);
    const layoutBuffer = scene.capture(layout, vehicles);
    assert.deepEqual(gridBuffer, legacyCapture(scene, grid, vehicles, CPU_LIDAR_NEAR_METERS, 30, gridDirections));
    assert.deepEqual(layoutBuffer, legacyCapture(scene, layout, vehicles, 0.1, 30, layoutDirections));
    assert.equal(gridBuffer[(1 * 2 + 0) * 4 + 3], 11);
    assert.equal(gridBuffer[(1 * 2 + 1) * 4 + 3], 31);
    assert.equal(layoutBuffer[3], 11);
    assert.equal(layoutBuffer[7], 31);
    assert.equal([...gridBuffer].filter((_, index) => index % 4 === 3).includes(32), false);
    vehicles[1].position.z = 8;
    assert.deepEqual(
        scene.capture(grid, vehicles),
        legacyCapture(scene, grid, vehicles, CPU_LIDAR_NEAR_METERS, 30, gridDirections),
    );
    scene.dispose();
});

test("a rotated rigid body matches triangles baked with the same pose", () => {
    const vertices = [
        { x: 5, y: -1, z: -1 },
        { x: 5, y: 1, z: -1 },
        { x: 5, y: 0, z: 1 },
    ];
    const triangle = createTriangleLidarTwin({
        id: "flag", sourceId: "flag", vertices, tags: ["building"], semanticId: 1, instanceId: 41,
    });
    const scene = new CpuLidarScene(resource([triangle]));
    const looking = sensor({
        calibration: {
            range: 20,
            azimuth: { startDeg: -90, endDeg: 90, stepDeg: 90 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
        },
    });
    const spawned = scene.capture(looking, [ego]);
    assert.ok(spawned[4] > 0);
    const pose = {
        id: "flag",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) },
        spawnPosition: { x: 0, y: 0, z: 0 },
        spawnRotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    scene.setRigidBodyPoses([pose]);
    const moved = scene.capture(looking, [ego]);
    const baked = createTriangleLidarTwin({
        id: "flag",
        sourceId: "flag",
        vertices: vertices.map((vertex) => transformRigidBodyPoint(vertex, pose)),
        tags: ["building"],
        semanticId: 1,
        instanceId: 41,
    });
    const bakedScene = new CpuLidarScene(resource([baked]));
    const expected = bakedScene.capture(looking, [ego]);
    for (let offset = 0; offset < expected.length; offset += 4) {
        assert.ok(Math.abs(moved[offset] - expected[offset]) < 1e-5, `distance ${moved[offset]} vs ${expected[offset]}`);
        assert.ok(Math.abs(moved[offset + 1] - expected[offset + 1]) < 1e-5);
        assert.equal(moved[offset + 2], expected[offset + 2]);
        assert.equal(moved[offset + 3], expected[offset + 3]);
    }
    assert.ok(moved[0] > 0);
    assert.equal(moved[4], 0);
    scene.dispose();
    bakedScene.dispose();
});

test("a rigid body at spawn uses the full static index and a moved body uses the reduced one", () => {
    const box = createBoxLidarTwin({
        id: "crate",
        sourceId: "crate",
        center: { x: 5, y: 0.5, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        tags: ["obstacle"],
        semanticId: 2,
        instanceId: 51,
    });
    const scene = new CpuLidarScene(resource([box]));
    const full = scene.fullStaticIndex;
    const before = scene.capture(sensor(), [ego]);
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const at = (y) => ({
        id: "crate",
        position: { x: 5, y, z: 0 },
        rotation: identity,
        spawnPosition: { x: 5, y: 0.5, z: 0 },
        spawnRotation: identity,
    });
    scene.setRigidBodyPoses([at(0.5)]);
    assert.equal(scene._bodyIndex, null);
    assert.deepEqual(scene.capture(sensor(), [ego]), before);
    assert.equal(scene._bodyIndex, null);
    assert.equal(scene._activeStaticIndex, full);
    assert.equal(scene.fullStaticIndex, full);
    scene.setRigidBodyPoses([at(4)]);
    scene.capture(sensor(), [ego]);
    assert.ok(scene._bodyIndex);
    assert.equal(scene._activeStaticIndex, scene.staticIndex);
    assert.notEqual(scene._activeStaticIndex, full);
    scene.setRigidBodyPoses([at(0.5)]);
    assert.deepEqual(scene.capture(sensor(), [ego]), before);
    assert.equal(scene._activeStaticIndex, full);
    assert.equal(scene.fullStaticIndex, full);
    scene.dispose();
});
