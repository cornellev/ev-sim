import assert from "node:assert/strict";
import test from "node:test";

import { TopicInputQueue } from "../app/simulation/TopicInputQueue.js";
import { SensorPublisher } from "../app/3d/devices/SensorPublisher.js";
import { buildNativeImage } from "../app/simulation/sensors/NativeSensorProducts.js";
function makeImage(bytes = 4096) { return buildNativeImage({ data: new Uint8Array(bytes), width: bytes / 4, height: 1 }); }

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
        topics: [{ id: "image", name: "/image", direction: "output", valueContract: { id: "cev.image", version: 1 } }],
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

test("native frame release clears payload references and reset releases observations", () => {
    let releases = 0;
    const publisher = new SensorPublisher({ telemetryId: "cam", releaseObservation() { releases++; } }, { id: "cam", rateHz: 60, latency: { fixedNs: 0, jitterNs: 0 }, outputs: {} }, { topics: [{ id: "image", name: "/image", direction: "output", valueContract: { id: "cev.image", version: 1 } }], runtimeData: { bindings: () => ({ signalStore: { publishSignal() {} } }) } });
    const frame = publisher.enqueue([{ topicId: "image", signal: "image", value: makeImage() }], 0, 0, { next: () => 0 }, { step: 1, stepNs: 16_666_667, timeNs: 16_666_667 });
    publisher.deliver({ step: 1, timeNs: 16_666_667 });
    assert.equal(frame.messages, null);
    assert.equal(publisher.queuedBytes, 0);
    publisher.queue.push({ observation: { value: new Float32Array(1) } });
    publisher.reset();
    assert.equal(releases, 1);
    assert.equal(publisher.queue.length, 0);
});
