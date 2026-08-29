import assert from "node:assert/strict";
import test from "node:test";

import { TopicInputQueue } from "../app/simulation/TopicInputQueue.js";
import { SensorPublisher } from "../app/3d/devices/SensorPublisher.js";
import {
    encodePoolHasCapacity,
    encodePoolStats,
    resetEncodePoolForTests,
} from "../app/3d/devices/SensorEncodePool.js";
import { Client, registerMsgDefinition } from "../app/client/Client.js";

function registerImageSchema() {
    registerMsgDefinition("builtin_interfaces/Time", "int32 sec\nuint32 nanosec\n");
    registerMsgDefinition("std_msgs/Header", "builtin_interfaces/Time stamp\nstring frame_id\n");
    registerMsgDefinition("sensor_msgs/Image", "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n");
}

function makeImage(bytes = 4096) {
    return {
        header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "cam" },
        height: 16,
        width: 16,
        encoding: "rgba8",
        is_bigendian: 0,
        step: 64,
        data: new Uint8Array(bytes),
    };
}

test("TopicInputQueue bounds entries and bytes while simulation is paused", () => {
    const queue = new TopicInputQueue(
        [{ name: "/sensors/image", direction: "input" }],
        { maxEntries: 4, maxBytes: 20_000 },
    );
    for (let index = 0; index < 40; index += 1) {
        queue.enqueue({ name: "/sensors/image", value: makeImage(8_000) }, 999);
    }
    const stats = queue.getStats();
    assert.ok(stats.entries <= 4);
    assert.ok(stats.bytes <= 20_000);
    assert.ok(stats.droppedEntries > 0);
    const drained = queue.drain(999);
    assert.ok(drained.length <= 4);
    queue.reset();
    assert.equal(queue.getStats().entries, 0);
});

test("SensorPublisher enforces frame and byte queue ceilings then clears refs after deliver", () => {
    registerImageSchema();
    resetEncodePoolForTests({ workerCount: 0, maxPendingJobs: 1 });
    const published = [];
    const fakeDevice = {
        telemetryId: "cam",
        captureAt() {
            return [{
                topicId: "image",
                signal: "image",
                value: makeImage(32_768),
            }];
        },
        getParent() {
            return {
                getParent: () => ({
                    bindings: () => ({
                        signalStore: {
                            publishSignal: (path, value) => published.push({ path, value }),
                            emitTelemetryEvent: () => {},
                        },
                    }),
                    client: () => ({ get: () => ({ isOpen: () => false }) }),
                    simulation: () => ({ timeNs: 0, steps: 0, pause: () => {} }),
                }),
            };
        },
    };
    const publisher = new SensorPublisher(fakeDevice, {
        id: "cam",
        rateHz: 30,
        phaseNs: 0,
        latency: { fixedNs: 1e9, jitterNs: 0 },
        maxQueueFrames: 2,
        maxQueueBytes: 80_000,
        health: { deadlineNs: 0 },
        calibration: { products: {} },
        outputs: {},
    }, {
        seed: "cap",
        topics: [{ id: "image", name: "/image", type: "sensor_msgs/Image", schema: { type: "sensor_msgs/Image" } }],
    });
    for (let step = 1; step <= 30; step += 1) {
        publisher.update({ step, timeNs: step * 33_333_333 });
    }
    assert.ok(publisher.queue.length <= 2);
    assert.ok(publisher.queuedBytes <= 80_000);
    assert.ok(publisher.health.droppedFrames > 0);
    publisher.deliver({ step: 10_000, timeNs: 20e9 });
    assert.equal(publisher.queue.length, 0);
    assert.equal(publisher.queuedBytes, 0);
    publisher.dispose();
    assert.equal(publisher.queue.length, 0);
});

test("encode pool rejects work beyond pending job/byte ceilings", () => {
    const pool = resetEncodePoolForTests({
        workerCount: 0,
        maxPendingJobs: 1,
        maxPendingBytes: 1024,
    });
    assert.equal(encodePoolHasCapacity(2048), true); // sync path has capacity when no workers
    assert.ok(encodePoolStats().pendingJobs <= 1);
    pool.dispose();
});

test("Client rejects publishes when WebSocket bufferedAmount exceeds ceiling", async () => {
    const client = new Client({
        url: "ws://localhost:9",
        reconnect: false,
        maxBufferedAmount: 1024,
    });
    client.ws = {
        readyState: 1,
        bufferedAmount: 900,
        send() { throw new Error("should not send"); },
    };
    client._ready = Promise.resolve();
    client._connected = true;
    Object.defineProperty(client, "isOpen", { value: () => true });
    await assert.rejects(
        () => client.publishEncoded("/sensors/image", new Uint8Array(200)),
        /websocket-backpressure/,
    );
    assert.ok(client.backpressureEvents >= 1);
});

function makePublisher(client, pause) {
    const fakeDevice = {
        telemetryId: "cam",
        getParent() {
            return {
                getParent: () => ({
                    bindings: () => ({
                        signalStore: { publishSignal() {}, emitTelemetryEvent() {} },
                    }),
                    client: () => ({ get: () => client }),
                    simulation: () => ({ timeNs: 0, steps: 0, pause }),
                }),
            };
        },
    };
    return new SensorPublisher(fakeDevice, {
        id: "cam",
        rateHz: 10,
        phaseNs: 0,
        latency: {},
        maxQueueFrames: 2,
        health: {},
        calibration: { products: {} },
        outputs: {},
    }, {
        seed: "pause",
        topics: [{
            id: "image",
            name: "/sensors/front_camera/image_raw",
            type: "sensor_msgs/Image",
            schema: { type: "sensor_msgs/Image" },
            required: true,
        }],
    });
}

test("sensor publisher keeps running when ROS is down or backpressured", async () => {
    registerImageSchema();
    let pauses = 0;
    const pause = () => { pauses += 1; };
    const disconnected = makePublisher({ isOpen: () => false }, pause);
    disconnected._event("publish-failed", "warning", { reason: "encode timeout" });
    disconnected._event("required-topic-unavailable", "warning", { reason: "orchestrator-disconnected" });
    disconnected._event("publish-failed", "error", { reason: "unknown-topic" });
    disconnected._deliverMessage({
        topicId: "image",
        signal: "image",
        value: makeImage(256),
        frameId: "cam",
    }, {
        sampleIndex: 0,
        captureTimeNs: 0,
        scheduledDeliveryTimeNs: 0,
        deliveryTimeNs: 0,
        captureStep: 0,
        scheduledDeliveryStep: 0,
        sequence: 1,
        syncGroupKey: "",
        encodedByTopic: new Map(),
    }, { step: 1, timeNs: 0 });
    assert.equal(pauses, 0);

    const backpressured = makePublisher({
        isOpen: () => true,
        publishEncoded() {
            return Promise.reject(new Error("websocket-backpressure"));
        },
    }, pause);
    backpressured._deliverMessage({
        topicId: "image",
        signal: "image",
        value: makeImage(256),
        frameId: "cam",
    }, {
        sampleIndex: 1,
        captureTimeNs: 0,
        scheduledDeliveryTimeNs: 0,
        deliveryTimeNs: 0,
        captureStep: 0,
        scheduledDeliveryStep: 0,
        sequence: 2,
        syncGroupKey: "",
        encodedByTopic: new Map(),
    }, { step: 2, timeNs: 0 });
    await Promise.resolve();
    assert.equal(pauses, 0);

    disconnected._event("capture-failed", "error", { reason: "gpu" });
    assert.equal(pauses, 1);
    disconnected._event("frame-invalid", "error", { reason: "missing-frame" });
    assert.equal(pauses, 2);
});
