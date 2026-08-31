import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    createBoxLidarTwin,
    createTriangleLidarTwin,
    hashLidarGeometry,
    LIDAR_GEOMETRY_KIND,
    LIDAR_GEOMETRY_VERSION,
} from "../app/simulation/lidar/LidarGeometry.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { compareUtf8 } from "../app/simulation/world/WorldDescription.js";

function resource(staticPrimitives = [], actors = []) {
    const description = {
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
        staticPrimitives: [...staticPrimitives].sort((left, right) => compareUtf8(left.id, right.id)),
        actors: [...actors].sort((left, right) => compareUtf8(left.actorId, right.actorId)),
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
