import assert from "node:assert/strict";
import test from "node:test";

import { buildNativeCameraInfo, buildNativeImage, buildNativePoints } from "../app/simulation/sensors/NativeSensorProducts.js";
import { flipRows } from "../app/3d/environment/visual/VisualCapturePipeline.js";
import { SensorPublisher, normalizeCaptureResult } from "../app/3d/devices/SensorPublisher.js";

test("camera rows are flipped to top-left order", () => {
    const bottomUp = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8,
        11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    assert.deepEqual([...flipRows(bottomUp, 2, 2, 4)], [
        11, 12, 13, 14, 15, 16, 17, 18,
        1, 2, 3, 4, 5, 6, 7, 8,
    ]);
});

test("camera Image and CameraInfo use simulated capture time and calibrated intrinsics", () => {
    const image = buildNativeImage({ data: new Uint8Array(16), width: 2, height: 2, timeNs: 1_500_000_007, frameId: "camera" });
    assert.equal(image.header, undefined);
    assert.equal(image.strideBytes, 8);
    const info = buildNativeCameraInfo({ width: 320, height: 180, verticalFovDeg: 90, timeNs: 0, frameId: "camera" });
    assert.ok(Math.abs(info.intrinsic[0] - 90) < 1e-10);
    assert.equal(info.intrinsic[2], 159.5);
    assert.equal(info.projection.length, 12);
});

test("LiDAR hit buffers retain the recorded REP-103 coordinate vector", () => {
    const cloud = buildNativePoints({ buffer: new Float32Array([0.5, 0, 0, 1, 0, 0, 0, 0]), bufferEncoding: "legacy-normalized", calibration: { range: 20, azimuth: { startDeg: 0, endDeg: 2, stepDeg: 1 }, elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 } } });
    assert.equal(cloud.count, 1);
    assert.deepEqual([...cloud.positions], [10, 0, 0]);
    assert.deepEqual([...cloud.intensities], [0.5]);
});

test("sensor rate and latency queues use integer simulation timestamps", () => {
    const captured = [];
    const fakeDevice = {
        telemetryId: "sensor",
        captureAt({ captureTimeNs }) {
            captured.push(captureTimeNs);
            return [{ topicId: "out", signal: "output", value: { data: "sample" } }];
        },
        getParent() { return { getParent: () => null }; },
    };
    const publisher = new SensorPublisher(fakeDevice, {
        id: "sensor",
        frameId: "sensor_frame",
        rateHz: 10,
        phaseNs: 0,
        latency: { fixedNs: 50_000_000, jitterNs: 0 },
        maxQueueFrames: 4,
    }, { seed: 42, topics: [{ id: "out", name: "/out", type: "std_msgs/String" }] });
    for (let step = 1; step <= 18; step += 1) publisher.update({ step, timeNs: step * 16_666_667 });
    assert.deepEqual(captured, [100_000_002, 200_000_004, 300_000_006]);
    assert.deepEqual(publisher.queue.map((frame) => frame.deliveryTimeNs), [150_000_002, 250_000_004, 350_000_006]);
    publisher.deliver({ step: 18, timeNs: 300_000_006 });
    assert.deepEqual(publisher.queue.map((frame) => frame.deliveryTimeNs), [350_000_006]);
});

test("sensor RNG streams are stable per seed, sensor id, and sample index", () => {
    const samplesFor = (seed, id) => {
        const samples = [];
        const device = {
            telemetryId: id,
            captureAt({ rng }) { samples.push(rng.next()); return []; },
            getParent() { return { getParent: () => null }; },
        };
        const publisher = new SensorPublisher(device, { id, rateHz: 10, phaseNs: 0, latency: {}, maxQueueFrames: 4 }, { seed, topics: [] });
        for (let step = 1; step <= 18; step += 1) publisher.update({ step, timeNs: step * 16_666_667 });
        return samples;
    };
    assert.deepEqual(samplesFor(42, "front"), samplesFor(42, "front"));
    assert.notDeepEqual(samplesFor(42, "front"), samplesFor(43, "front"));
    assert.notDeepEqual(samplesFor(42, "front"), samplesFor(42, "rear"));
});

test("publisher capture results can delay GPU sample timestamps by one period", () => {
    const captured = [];
    const fakeDevice = {
        telemetryId: "sensor",
        captureAt({ captureTimeNs, sampleIndex }) {
            captured.push({ captureTimeNs, sampleIndex });
            if (sampleIndex === 0) {
                return { messages: [], captureTimeNs, sampleIndex };
            }
            return {
                messages: [{ topicId: "out", signal: "output", value: { data: "late" } }],
                captureTimeNs: captured[sampleIndex - 1].captureTimeNs,
                sampleIndex: sampleIndex - 1,
            };
        },
        getParent() { return { getParent: () => null }; },
    };
    const publisher = new SensorPublisher(fakeDevice, {
        id: "sensor",
        frameId: "sensor_frame",
        rateHz: 10,
        phaseNs: 0,
        latency: { fixedNs: 50_000_000, jitterNs: 0 },
        maxQueueFrames: 4,
    }, { seed: 42, topics: [{ id: "out", name: "/out", type: "std_msgs/String" }] });
    for (let step = 1; step <= 18; step += 1) publisher.update({ step, timeNs: step * 16_666_667 });
    assert.equal(publisher.health.capturedFrames, 2);
    assert.equal(publisher.queue[0].captureTimeNs, 100_000_002);
    assert.equal(publisher.queue[0].sampleIndex, 0);
    assert.equal(publisher.queue[0].deliveryTimeNs, 150_000_002);
    assert.equal(publisher.queue[1].captureTimeNs, 200_000_004);
    assert.equal(publisher.queue[1].sampleIndex, 1);
});

test("normalizeCaptureResult keeps array returns on the current sample stamp", () => {
    const array = normalizeCaptureResult([{ topicId: "a" }], 10, 3);
    assert.deepEqual(array.messages, [{ topicId: "a" }]);
    assert.equal(array.captureTimeNs, 10);
    assert.equal(array.sampleIndex, 3);
    const delayed = normalizeCaptureResult({
        messages: [{ topicId: "b" }],
        captureTimeNs: 5,
        sampleIndex: 1,
        rng: { next: () => 0 },
    }, 10, 3);
    assert.equal(delayed.captureTimeNs, 5);
    assert.equal(delayed.sampleIndex, 1);
    assert.equal(delayed.messages[0].topicId, "b");
    assert.ok(delayed.rng);
});
