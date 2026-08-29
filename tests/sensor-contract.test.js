import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_TOPIC_NAME_LEN,
    buildTopicData,
    decodeValue,
    encodeTopicValue,
    registerMsgDefinition,
} from "../app/client/Client.js";
import {
    buildCameraInfo,
    buildImageMessage,
    buildPointCloud2,
    flipRgbaRows,
} from "../app/3d/devices/SensorMessages.js";
import { SensorPublisher, normalizeCaptureResult } from "../app/3d/devices/SensorPublisher.js";

function registerSensorSchemas() {
    registerMsgDefinition("builtin_interfaces/Time", "int32 sec\nuint32 nanosec\n");
    registerMsgDefinition("std_msgs/Header", "builtin_interfaces/Time stamp\nstring frame_id\n");
    registerMsgDefinition("sensor_msgs/Image", "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n");
    registerMsgDefinition("sensor_msgs/CameraInfo", "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\n");
    registerMsgDefinition("sensor_msgs/PointField", "string name\nuint32 offset\nuint8 datatype\nuint32 count\n");
    registerMsgDefinition("sensor_msgs/PointCloud2", "std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n");
}

test("orchestrator primitive framing matches upstream protocol vectors", () => {
    const encodedString = encodeTopicValue("std_msgs/String", "hello");
    assert.equal(Buffer.from(encodedString).toString("hex"), "01090000000500000068656c6c6f");

    const encodedChar = encodeTopicValue("std_msgs/Char", "A");
    assert.equal(Buffer.from(encodedChar).toString("hex"), "0a0100000041");
    assert.equal(decodeValue(encodedChar, 0).value, "A");
});

test("orchestrator client rejects oversized topics and truncated payloads", () => {
    const valid = buildTopicData("x".repeat(MAX_TOPIC_NAME_LEN), "std_msgs/Int32", 1);
    assert.equal(valid[0], MAX_TOPIC_NAME_LEN);
    assert.throws(
        () => buildTopicData("x".repeat(MAX_TOPIC_NAME_LEN + 1), "std_msgs/Int32", 1),
        /Topic name exceeds/
    );
    assert.throws(
        () => decodeValue(Uint8Array.from([0x01, 0x09, 0x00, 0x00, 0x00, 0x05, 0x00]), 0),
        /Truncated typed payload/
    );
});

test("camera rows are flipped to ROS top-left order", () => {
    const bottomUp = new Uint8Array([
        1, 2, 3, 4, 5, 6, 7, 8,
        11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    assert.deepEqual([...flipRgbaRows(bottomUp, 2, 2)], [
        11, 12, 13, 14, 15, 16, 17, 18,
        1, 2, 3, 4, 5, 6, 7, 8,
    ]);
});

test("camera Image and CameraInfo use simulated capture time and calibrated intrinsics", () => {
    const image = buildImageMessage({ data: new Uint8Array(16), width: 2, height: 2, timeNs: 1_500_000_007, frameId: "camera" });
    assert.deepEqual(image.header.stamp, { sec: 1, nanosec: 500_000_007 });
    assert.equal(image.step, 8);
    const info = buildCameraInfo({ width: 320, height: 180, verticalFovDeg: 90, timeNs: 0, frameId: "camera" });
    assert.ok(Math.abs(info.k[0] - 90) < 1e-10);
    assert.equal(info.k[2], 159.5);
    assert.equal(info.p.length, 12);
});

test("LiDAR hit buffers produce standard little-endian PointCloud2 data", () => {
    const cloud = buildPointCloud2({
        buffer: new Float32Array([0.5, 0, 0, 1, 0, 0, 0, 0]),
        calibration: {
            range: 20,
            azimuth: { startDeg: 0, endDeg: 2, stepDeg: 1 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
        },
        timeNs: 20,
        frameId: "lidar",
    });
    assert.equal(cloud.width, 1);
    assert.equal(cloud.point_step, 16);
    assert.equal(cloud.row_step, 16);
    const view = new DataView(cloud.data.buffer);
    assert.equal(view.getFloat32(0, true), 10);
    assert.equal(view.getFloat32(4, true), 0);
    assert.equal(view.getFloat32(8, true), 0);
    assert.equal(view.getFloat32(12, true), 0.5);
});

test("ROS Image and PointCloud2 payloads round-trip nested headers and byte arrays", () => {
    registerSensorSchemas();
    const image = buildImageMessage({ data: new Uint8Array([1, 2, 3, 255]), width: 1, height: 1, timeNs: 2_000_000_003, frameId: "camera" });
    const imageBytes = encodeTopicValue("sensor_msgs/Image", image);
    const decodedImage = decodeValue(imageBytes, 0);
    assert.equal(decodedImage.type, "sensor_msgs/Image");
    assert.equal(decodedImage.value.header.stamp.nanosec, 3);
    assert.deepEqual([...decodedImage.value.data], [1, 2, 3, 255]);

    const cloud = buildPointCloud2({
        buffer: new Float32Array([0.75, 0, 0, 1]),
        calibration: { range: 8, azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 }, elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 } },
        timeNs: 3,
        frameId: "lidar",
    });
    const cloudBytes = encodeTopicValue("sensor_msgs/PointCloud2", cloud);
    const decodedCloud = decodeValue(cloudBytes, 0);
    assert.equal(decodedCloud.value.width, 1);
    assert.equal(decodedCloud.value.data.length, 16);
    assert.equal(decodedCloud.value.fields[3].name, "intensity");

    const infoBytes = encodeTopicValue("sensor_msgs/CameraInfo", buildCameraInfo({ width: 640, height: 480, verticalFovDeg: 60, timeNs: 9, frameId: "camera" }));
    const decodedInfo = decodeValue(infoBytes, 0);
    assert.equal(decodedInfo.value.k.length, 9);
    assert.equal(decodedInfo.value.header.frame_id, "camera");

    const large = buildImageMessage({ data: new Uint8Array(262_144).fill(17), width: 65_536, height: 1, timeNs: 10, frameId: "camera" });
    const decodedLarge = decodeValue(encodeTopicValue("sensor_msgs/Image", large), 0);
    assert.equal(decodedLarge.value.data.length, 262_144);
    assert.equal(decodedLarge.value.data[262_143], 17);
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
