import assert from "node:assert/strict";
import test from "node:test";
import { BindingRuntime } from "../app/scripting/bindings/BindingRuntime.js";
import { normalizeOutputMapping } from "../app/scripting/bindings/BindingDocument.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SIGNAL_PATHS, topicSignalPath } from "../app/scripting/runtime/SignalPaths.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { listNativeTopicDefinitions, defaultNativeManifestTopics, topicFromNativeContract } from "../app/simulation/NativeTopicCatalog.js";
import { getNativeTopicContract } from "../app/simulation/NativeTopicContracts.js";
import { proposeSensorWiring } from "../app/simulation/sensors/SensorWiring.js";
import { createRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";

test("native authoring defaults and sensor wiring contain no legacy schemas", () => {
    for (const topic of listNativeTopicDefinitions()) {
        assert.equal(Object.hasOwn(topic, "type"), false);
        assert.equal(Object.hasOwn(topic, "schema"), false);
        getNativeTopicContract(topic.valueContract.id, topic.valueContract.version);
    }
    assert.ok(defaultNativeManifestTopics().length > 20);
    const source = { version: 13, topics: [], sensorRig: { sensors: [createRunSensor("imu", { id: "imu" })] } };
    const result = proposeSensorWiring(source);
    assert.equal(result.issues.length, 0);
    assert.equal(result.manifest.topics[0].valueContract.id, "cev.imu");
    assert.equal(Object.hasOwn(result.manifest.sensorRig.sensors[0], "schema"), false);
    assert.equal(source.topics.length, 0);
});

test("native bindings publish through the router and propagate transport rejection", () => {
    const topic = { id: "value", name: "/value", direction: "output", producer: "simulator", valueContract: { id: "cev.scalar-f64", version: 1 } };
    const signalStore = new SignalStore();
    signalStore.set(SIGNAL_PATHS.SIMULATION, { time: 0.25, step: 15 });
    const packets = [];
    const router = new TopicContractRouter({ version: 13, id: "run", topics: [topic] }, { telemetry: signalStore, publicationPort: (packet) => { packets.push(packet); return true; } });
    const runtime = new BindingRuntime({ autoLoad: false, signalStore });
    runtime.setTopicRouter(router, [topic]);
    const mapping = normalizeOutputMapping({ output: "value", sink: "publish", topic: topic.id, valueContract: topic.valueContract });
    runtime._routeOutputs({ outputs: [mapping] }, { value: 3 });
    assert.equal(packets[0].value, 3);
    assert.equal(packets[0].metadata.captureTimeNs, 250_000_000);
    assert.equal(Object.hasOwn(mapping, "type"), false);
    assert.throws(() => runtime._routeOutputs({ outputs: [{ ...mapping, valueContract: { id: "cev.text", version: 1 } }] }, { value: 3 }), /different native contract/);
    router.publicationPort = () => false;
    assert.throws(() => runtime._routeOutputs({ outputs: [mapping] }, { value: 3 }), /Cannot publish/);
    runtime.dispose();
});

test("native capture identity reaches observers and binding signal metadata", () => {
    const topic = topicFromNativeContract("planning-path");
    const signals = new SignalStore();
    const router = new TopicContractRouter({ version: 13, id: "run", topics: [topic] }, { telemetry: signals });
    const runtime = new BindingRuntime({ autoLoad: false, signalStore: signals });
    const observed = [];
    router.addObserver((info) => { observed.push(info); runtime.applyTopicUpdate(info); });
    const metadata = { runId: "run", frameId: "world", captureTimeNs: 10, sequenceId: "9007199254740993" };
    const result = router.routeInbound({ name: topic.name, valueContract: topic.valueContract, value: { points: [{ x: 1, y: 2, z: 3 }] }, metadata, captureTimeNs: 10 }, { applyStep: 2, applyTimeNs: 20, arrivalTimeNs: 15 });
    assert.equal(result.ok, true);
    assert.equal(observed[0].metadata.sequenceId, metadata.sequenceId);
    assert.equal(observed[0].metadata.frameId, "world");
    assert.equal(observed[0].captureTimeNs, 10);
    assert.equal(signals.read(topicSignalPath(topic.name)).metadata.valueContract.id, "cev.path");
    assert.equal(router.routeInbound({ name: topic.name, valueContract: { id: "cev.path", version: 2 }, value: { points: [] } }).code, "contract-mismatch");
    runtime.dispose();
});
