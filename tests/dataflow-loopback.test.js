import assert from "node:assert/strict";
import test from "node:test";

import { defaultNativeManifestTopics } from "../app/simulation/NativeTopicCatalog.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { buildCalibrationBundle } from "../app/autonomy/CalibrationBundle.js";
import { TransformRuntime } from "../app/simulation/TransformRuntime.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { buildNativeImage, buildNativeCameraInfo } from "../app/simulation/sensors/NativeSensorProducts.js";

function harness() {
    const store = new SignalStore({}, { sourceId: "native-dataflow" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    return { store, manifest, router };
}

test("topic router routes native controls through producer and active paths", () => {
    const { store, manifest, router } = harness();
    const topic = manifest.topics.find((entry) => entry.contractId === "controls-command");
    const value = { runId: manifest.id, mode: "velocity", sequence: "1", captureTimeNs: 0, deadlineNs: 100_000_000, frameId: "base_link", speedMps: 1, steeringRad: 0, accelerationMps2: 0, jerkMps3: 0, steeringRateRadps: 0 };
    const routed = router.routeInbound({ name: topic.name, valueContract: topic.valueContract, value }, { applyStep: 1, applyTimeNs: 16_666_667, arrivalTimeNs: 16_666_667 });
    assert.equal(routed.ok, true);
    assert.deepEqual(store.read("candidate.topics.controls-command").value, value);
    assert.deepEqual(store.read("active.topics.controls-command").value, value);
    assert.equal(router.routeInbound({ name: topic.name, valueContract: { id: "cev.goal", version: 1 }, value }).ok, false);
});

test("perception returns preserve capture time without writing active paths", () => {
    const { store, manifest, router } = harness();
    const topic = manifest.topics.find((entry) => entry.contractId === "perception-detections-2d");
    const routed = router.routeInbound({ name: topic.name, valueContract: topic.valueContract, value: { detections: [] }, metadata: { captureTimeNs: 2_000_000_000 } }, { applyStep: 3, applyTimeNs: 50_000_000, arrivalTimeNs: 49_000_000 });
    assert.equal(routed.ok, true);
    assert.equal(routed.envelope.captureTimeNs, 2_000_000_000);
    assert.equal(routed.envelope.arrivalTimeNs, 49_000_000);
    assert.equal(routed.envelope.applyTimeNs, 50_000_000);
    assert.ok(store.read("candidate.topics.perception-detections-2d").exists);
    assert.equal(store.read("active.topics.perception-detections-2d").exists, false);
    assert.equal(store.read("diagnostics.topics.perception-detections-2d").value.status, "ok");
});

test("native catalog declares live outputs and explicit controls", () => {
    const topics = defaultNativeManifestTopics();
    for (const id of ["front-camera-image", "front-camera-depth", "front-lidar-semantic", "oracle-detections-2d", "imu", "truth-odometry", "localization-estimate", "perception-detections-3d", "perception-lanes", "tf", "tf-static", "controls-command"]) {
        const topic = topics.find((entry) => entry.contractId === id);
        assert.ok(topic, id);
        assert.ok(topic.valueContract?.id, id);
        assert.equal(topic.schema, undefined);
    }
    assert.equal(topics.find((topic) => topic.contractId === "front-camera-depth").authority, "oracle");
});

test("native perception products share calibration and synchronization metadata", () => {
    const { store, manifest, router } = harness();
    const calibration = buildCalibrationBundle(manifest);
    const syncGroupKey = "perception-primary:60";
    const products = {
        "front-camera-image": buildNativeImage({ data: new Uint8Array(4), width: 1, height: 1 }),
        "front-camera-info": buildNativeCameraInfo({ width: 1, height: 1 }),
        "front-lidar-points": { positions: new Float32Array(0), intensities: new Float32Array(0), count: 0 },
        "front-camera-depth": buildNativeImage({ data: new Float32Array(1), width: 1, height: 1, encoding: "32FC1" }),
    };
    for (const [id, value] of Object.entries(products)) {
        const topic = router.getTopic(id);
        assert.equal(router.routeOutbound(id, { value, valueContract: topic.valueContract }, { producer: topic.producer, observationalOracle: topic.producer === "oracle", captureTimeNs: 1_000_000_000, deliveryTimeNs: 1_000_000_000, syncGroupKey, calibrationHash: calibration.hash, sequenceId: "0", cycle: 60 }).ok, true);
        const entry = store.read(router.producerPath(topic, topic.producer));
        assert.equal(entry.metadata.syncGroupKey, syncGroupKey);
        assert.equal(entry.metadata.calibrationHash, calibration.hash);
        assert.equal(entry.metadata.captureTimeNs, 1_000_000_000);
        assert.equal(entry.metadata.valueContract.id, topic.valueContract.id);
    }
    assert.equal(store.read("active.topics.front-camera-depth").exists, false);
});

test("non-routed sensor topics retain the owned native pixel payload", () => {
    const { store, router } = harness();
    const topic = router.getTopic("front-camera-image");
    const value = buildNativeImage({ data: Uint8Array.from([1, 2, 3, 4]), width: 1, height: 1 });
    assert.equal(router.routeOutbound(topic.id, { value, valueContract: topic.valueContract }, { logClass: "heavy", captureTimeNs: 1, deliveryTimeNs: 1, cycle: 1 }).ok, true);
    assert.equal(store.read(router.producerPath(topic)).value, value);
    assert.equal(router.lastProducer.get(topic.contractId).value, value);
});

test("transform runtime publishes native transforms with fixed-step timestamps", () => {
    const { store, manifest, router } = harness();
    const runtime = new TransformRuntime(buildCalibrationBundle(manifest), router);
    runtime.publishStaticTransforms(0);
    runtime.publishDynamicTransforms(16_666_667, 1, [{ telemetryId: "ego", position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } }]);
    const tf = store.read("topics./tf");
    const tfStatic = store.read("topics./tf_static");
    assert.ok(tf.value.transforms.length >= 2);
    assert.equal(tf.value.transforms[1].childFrameId, "base_link");
    assert.equal(tf.timeUs, 16_667);
    assert.equal(tf.cycle, 1);
    assert.equal(tfStatic.timeUs, 0);
    assert.equal(tfStatic.cycle, 0);
});
