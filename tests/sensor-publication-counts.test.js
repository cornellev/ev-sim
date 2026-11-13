import assert from "node:assert/strict";
import test from "node:test";

import { SensorPublisher } from "../app/simulation/sensors/SensorPublisher.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";

const topic = { id: "output", name: "/test", type: "test/Message", direction: "output" };
const message = { topicId: topic.id, signal: "measurement", value: { count: 1 } };
const packet = { productId: "points", streamId: "main", packetIndex: 0, offsetNs: 0, payload: new Uint8Array([1]) };
const clock = { step: 1, timeNs: 10_000_000 };

test("native delivery publishes once after local acceptance and bypasses ROS encoding", () => {
    const topic = { id: "output", name: "/native", direction: "output", valueContract: { id: "cev.points", version: 1 }, producer: "simulator", routeDownstream: false };
    const store = new SignalStore(), accepted = [];
    const publicationPort = (envelope) => { accepted.push(envelope); return { ok: true }; };
    const router = new TopicContractRouter({ topics: [topic] }, { telemetry: store, publicationPort });
    const output = new SensorPublisher({ telemetryId: "native" }, { id: "native", rateHz: 100, latency: { fixedNs: 0, jitterNs: 0 }, outputs: {} }, {
        nativeTopics: true, topics: [topic], runtimeData: { bindings: () => ({ signalStore: store }) }, topicRouter: router, publicationPort,
        encodeTopicValue: () => { throw new Error("ROS encoder called"); },
    });
    const value = { positions: new Float32Array([1, 2, 3]), intensities: new Float32Array([0.5]), count: 1 };
    output.queue.push({ sampleIndex: 0, captureTimeNs: 0, captureStep: 0, deliveryTimeNs: 0, scheduledDeliveryTimeNs: 0, sequence: 0,
        messages: [{ topicId: topic.id, signal: "points", value }] });
    output.deliver(clock);
    assert.equal(accepted.length, 1); assert.equal(accepted[0].metadata.actualDeliveryStep, clock.step);
    assert.equal(accepted[0].value, value); assert.equal(output.health.publishedFrames, 1);
    const retained = store.read("devices.native.points").value;
    output.queue.push({ sampleIndex: 1, captureTimeNs: 0, captureStep: 0, deliveryTimeNs: 0, sequence: 1,
        messages: [{ topicId: topic.id, signal: "points", value: { ...value, count: 5 } }] });
    output.deliver(clock);
    assert.equal(accepted.length, 1); assert.equal(store.read("devices.native.points").value, retained);
    assert.equal(store.snapshot({ includeHeavy: false })["devices.native.points"], undefined);
});

function publisher(options = {}, data = null) {
    const store = new SignalStore();
    return new SensorPublisher({ telemetryId: "sensor" }, { id: "sensor", rateHz: 100 }, {
        runtimeData: data ?? { bindings: () => ({ signalStore: store }) }, topics: [topic],
        encodeTopicValue: () => new Uint8Array([1]), ...options,
    });
}

function deliver(output, frame = {}) {
    output.queue.push({ sampleIndex: 0, captureTimeNs: 0, captureStep: 0, deliveryTimeNs: 0, scheduledDeliveryTimeNs: 0,
        sequence: 0, messages: [message], ...frame });
    output.health.capturedFrames += 1;
    output.deliver(clock);
    return output.health;
}

test("processed and published differ for mapping, encoding, sink and route failures; partial data survives", () => {
    const success = publisher();
    assert.equal(deliver(success).publishedFrames, 1);
    const failed = [
        publisher({ topics: [] }),
        publisher({ topics: [{ ...topic, type: undefined }] }),
        publisher({ encodeTopicValue: () => { throw new Error("encode failed"); } }),
        publisher({ encodeTopicValue: () => undefined }),
        publisher({}, { bindings: () => ({}) }),
        publisher({ topicRouter: { routeOutbound: () => ({ ok: false }) } }),
        publisher({}, { bindings: () => ({ signalStore: { publishSignal: () => false } }) }),
    ];
    for (const output of failed) {
        const health = deliver(output);
        assert.equal(health.processedFrames, 1);
        assert.equal(health.publishedFrames, 0);
        assert.equal(health.deliveredFrames, 1);
    }
    const partial = publisher();
    deliver(partial, { messages: [message, { ...message, topicId: "missing" }] });
    assert.equal(partial.health.publishedFrames, 0);
    assert.ok(partial.runtimeData.bindings().signalStore.read("devices.sensor.measurement"));
    assert.equal(deliver(publisher(), { messages: [{ ...message, signal: undefined }] }).publishedFrames, 0);
});

test("observation-only and encode-failed frames are processed, strict failures never publish, reset clears counters", () => {
    const output = publisher();
    deliver(output, { messages: [], observation: { points: [1] } });
    assert.equal(output.health.processedFrames, 1);
    assert.equal(output.health.publishedFrames, 0);
    deliver(output, { encodeFailed: true });
    assert.equal(output.health.processedFrames, 2);
    assert.equal(output.health.deliveredFrames, 1);
    const state = output.getDeterministicState();
    assert.equal(Object.hasOwn(state.health, "processedFrames"), false);
    assert.equal(Object.hasOwn(state.health, "publishedFrames"), false);
    output.reset();
    assert.equal(output.health.processedFrames, 0);
    assert.equal(output.health.publishedFrames, 0);
    const strict = publisher({ pluginStrict: true, topics: [] });
    assert.throws(() => deliver(strict), /Unknown topic/);
    assert.equal(strict.health.processedFrames, 1);
    assert.equal(strict.health.publishedFrames, 0);
});

test("native frames require valid local products, and remote transport errors do not undo local publication", async () => {
    assert.equal(deliver(publisher(), { messages: [], nativePackets: [packet] }).publishedFrames, 1);
    assert.equal(deliver(publisher(), { nativePackets: [{ ...packet, packetIndex: -1 }] }).publishedFrames, 0);
    assert.equal(deliver(publisher(), { nativePackets: [{ ...packet, productId: undefined }] }).publishedFrames, 0);
    assert.equal(deliver(publisher({ nativePacketSink: { enqueueBatch: () => false } }), { nativePackets: [packet] }).publishedFrames, 1);
    assert.equal(deliver(publisher({}, { bindings: () => ({}) }), { messages: [], nativePackets: [packet] }).publishedFrames, 0);
    const failedTransport = publisher({ nativePacketSink: { enqueueBatch: () => { throw new Error("transport failed"); } } });
    assert.throws(() => deliver(failedTransport, { messages: [], nativePackets: [packet] }), /transport failed/);
    assert.equal(failedTransport.health.publishedFrames, 1);
    assert.equal(deliver(publisher({ nativePacketSink: { enqueueBatch: () => true } }, { bindings: () => ({}) }), { messages: [], nativePackets: [packet] }).publishedFrames, 0);
    const store = new SignalStore();
    for (const publishEncoded of [() => Promise.reject(new Error("disconnected")), () => { throw new Error("disconnected"); }]) {
        const output = publisher({}, { bindings: () => ({ signalStore: store }), client: () => ({ get: () => ({ isOpen: () => true, publishEncoded }) }) });
        assert.equal(deliver(output).publishedFrames, 1);
        await Promise.resolve();
        assert.equal(output.health.publishedFrames, 1);
    }
    let remoteSent = false;
    const remoteOnly = publisher({}, { bindings: () => ({}), client: () => ({ get: () => ({
        isOpen: () => true, publishEncoded: () => { remoteSent = true; return Promise.resolve(); },
    }) }) });
    assert.equal(deliver(remoteOnly).publishedFrames, 0);
    assert.equal(remoteSent, true);
});
