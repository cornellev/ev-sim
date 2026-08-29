import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildPointCloud2,
    packPointCloud2DataJs,
    packSemanticPointCloud2DataJs,
} from "../app/3d/devices/SensorMessages.js";
import { encodeTopicValueAsync, isHeavySensorValue } from "../app/3d/devices/SensorEncodePool.js";
import { registerMsgDefinition } from "../app/client/Client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(__dirname, "../public/native/sensor_kernels_bg.wasm");

const CALIBRATION = {
    range: 20,
    azimuth: { startDeg: 0, endDeg: 2, stepDeg: 1 },
    elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
};

test("JS PointCloud2 packer matches little-endian contract without per-hit objects", () => {
    const packed = packPointCloud2DataJs({
        buffer: new Float32Array([0.5, 0, 0, 1, 0, 0, 0, 0]),
        calibration: CALIBRATION,
        bufferEncoding: "legacy-normalized",
    });
    assert.equal(packed.width, 1);
    assert.equal(packed.pointStep, 16);
    const view = new DataView(packed.data.buffer, packed.data.byteOffset, packed.data.byteLength);
    assert.equal(view.getFloat32(0, true), 10);
    assert.equal(view.getFloat32(12, true), 0.5);
});

test("WASM PointCloud2 packer matches JS when wasm is available", async () => {
    if (!existsSync(wasmPath)) {
        assert.ok(true, "wasm artifact not present; skipping");
        return;
    }
    const kernels = await import("../app/native/sensor_kernels/sensor_kernels.js");
    await kernels.default({ module_or_path: readFileSync(wasmPath) });

    const js = packPointCloud2DataJs({
        buffer: new Float32Array([0.5, 0, 0, 1]),
        calibration: CALIBRATION,
        bufferEncoding: "legacy-normalized",
    });
    const wasmBytes = kernels.pack_pointcloud2(
        new Float32Array([0.5, 0, 0, 1]),
        20, 0, 2, 1, 0, 1, 1, "legacy-normalized",
    );
    assert.deepEqual([...wasmBytes], [...js.data]);

    const jsSemantic = packSemanticPointCloud2DataJs({
        buffer: new Float32Array([5, 0.5, 3, 9]),
        calibration: CALIBRATION,
        bufferEncoding: "metric-v2",
    });
    const wasmSemantic = kernels.pack_semantic_pointcloud2(
        new Float32Array([5, 0.5, 3, 9]),
        20, 0, 2, 1, 0, 1, 1, "metric-v2",
    );
    assert.deepEqual([...wasmSemantic], [...jsSemantic.data]);
});

test("encodeTopicValueAsync falls back synchronously for non-heavy values", async () => {
    registerMsgDefinition("std_msgs/String", "string data");
    const encoded = await encodeTopicValueAsync("std_msgs/String", "hello", { forceSync: true });
    assert.ok(encoded instanceof Uint8Array);
    assert.ok(encoded.byteLength > 0);
    assert.equal(isHeavySensorValue({ data: "x" }), false);
    assert.equal(isHeavySensorValue({
        width: 1,
        height: 1,
        encoding: "rgba8",
        data: new Uint8Array(4),
    }), true);
});

test("buildPointCloud2 stays byte-stable for the sensor-contract vector", () => {
    const cloud = buildPointCloud2({
        buffer: new Float32Array([0.5, 0, 0, 1, 0, 0, 0, 0]),
        calibration: CALIBRATION,
        timeNs: 20,
        frameId: "lidar",
    });
    assert.equal(cloud.width, 1);
    assert.equal(cloud.point_step, 16);
    const view = new DataView(cloud.data.buffer, cloud.data.byteOffset, cloud.data.byteLength);
    assert.equal(view.getFloat32(0, true), 10);
});
