import assert from "node:assert/strict";
import { register } from "node:module";
import { performance } from "node:perf_hooks";
import { createRigidBodyMotionFixture } from "../tests/helpers/rigidBodyMotionFixture.js";
import { flushRigidBodyLidarSolids, setRigidBodyLidarPoses } from "../app/3d/editor/projection/rigidBodyLidarSolids.js";

register(new URL("../tests/helpers/resolve-app-modules.js", import.meta.url));
await import("../app/3d/data/VehicleDatabase.js");
const { ObjectDatabase } = await import("../app/3d/data/ObjectDatabase.js");

for (const triangleCount of [1000, 5000]) {
    const { data, poses } = createRigidBodyMotionFixture(ObjectDatabase, triangleCount);
    const samples = [];
    for (let index = 0; index < 110; index += 1) {
        poses[0].position.x = index + 1;
        const start = performance.now();
        setRigidBodyLidarPoses(data, poses);
        assert.equal(flushRigidBodyLidarSolids(data), triangleCount);
        if (index >= 10) samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const start = performance.now();
    for (let index = 0; index < 100; index += 1) {
        setRigidBodyLidarPoses(data, poses);
        assert.equal(flushRigidBodyLidarSolids(data), 0);
    }
    console.log(JSON.stringify({ triangleCount, changedP50Ms: samples[50], changedP95Ms: samples[95], unchangedMeanMs: (performance.now() - start) / 100 }));
}
