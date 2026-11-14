import assert from "node:assert/strict";
import test from "node:test";

import { topicFromNativeContract as topicFromContract } from "../app/simulation/NativeTopicCatalog.js";
import { validateNativeTopicValue } from "../app/simulation/NativeTopicContracts.js";
import { buildNativeOdometry } from "../app/simulation/sensors/NativeSensorProducts.js";
import {
    normalizeDetections3D as normalizeNativeDetections3D,
    normalizeOdometry,
    VISUALIZATION_STATUS,
} from "../app/autonomy/AutonomyVisualizationModel.js";
import { composeRep103Poses } from "../app/autonomy/CoordinateFrames.js";
import { CandidateOutputRuntime } from "../app/autonomy/CandidateOutputRuntime.js";
import { buildCalibrationBundle } from "../app/autonomy/CalibrationBundle.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { TransformRuntime } from "../app/simulation/TransformRuntime.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { LogDataset } from "../app/logging/LogDataset.js";

const detectionContract = { id: "cev.detections-3d", version: 1 };
function detection3dPayload({ position, size = { x: 1, y: 1, z: 1 } }) {
    return { detections: [{ id: "1", classId: "vehicle", score: 1, pose: { position, orientation: { x: 0, y: 0, z: 0, w: 1 } }, size, visibility: 1, occlusion: 0 }] };
}
function normalizeDetections3D(value, options = {}) {
    return normalizeNativeDetections3D(value, { valueContract: detectionContract, metadata: { frameId: "map", captureTimeNs: 0 }, ...options });
}
test("native detection validation rejects non-finite geometry", () => {
    const result = validateNativeTopicValue(detectionContract, detection3dPayload({ position: { x: NaN, y: 0, z: 0 } }));
    assert.equal(result.ok, false);
});
test("normalizeDetections3D maps REP-103 centers into three-space", () => {
    const [box] = normalizeDetections3D(detection3dPayload({ position: { x: 2, y: 1, z: 0.5 }, size: { x: 4, y: 2, z: 1.5 } }));
    assert.deepEqual(box.box3d.threeCenter, { x: 2, y: 0.5, z: -1 });
    assert.equal(box.classId, "vehicle");
});
test("empty native telemetry waits without trying to normalize absent products", () => {
    const telemetry = new SignalStore();
    const runtime = new CandidateOutputRuntime({ telemetry, manifest: createDefaultRunManifest() });
    assert.doesNotThrow(() => runtime.refreshOracle());
    assert.deepEqual(runtime.lastPerception.oracle.detections3d, []);
});

test("map-frame 3D detections keep world centers when TF is applied", () => {
    const bundle = buildCalibrationBundle(createDefaultRunManifest());
    const tf = new TransformRuntime(bundle, { routeOutbound() {}, getTopic() { return null; } });
    tf.publishDynamicTransforms(0, 0, [{
        telemetryId: "ego",
        position: { x: 10, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    }]);
    const runtime = new CandidateOutputRuntime({ transformRuntime: tf });
    const transformToMap = runtime._transformToMapBinder(0);
    const [box] = normalizeDetections3D(
        detection3dPayload({ frameId: "map", position: { x: 12, y: -3, z: 0.7 } }),
        { source: "oracle", transformToMap },
    );
    assert.equal(box.status, VISUALIZATION_STATUS.OK);
    assert.equal(box.box3d.center.x, 12);
    assert.equal(box.box3d.center.y, -3);
    assert.equal(box.box3d.center.z, 0.7);
    assert.equal(box.box3d.threeCenter.x, 12);
    assert.equal(box.box3d.threeCenter.y, 0.7);
    assert.equal(box.box3d.threeCenter.z, 3);
});

test("optical-frame 3D detections compose child-most-first into map", () => {
    const bundle = buildCalibrationBundle(createDefaultRunManifest());
    const tf = new TransformRuntime(bundle, { routeOutbound() {}, getTopic() { return null; } });
    tf.publishDynamicTransforms(0, 0, [{
        telemetryId: "ego",
        position: { x: 10, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    }]);
    const chain = tf.lookupTransformChain("front_camera_optical_frame", "map", 0);
    assert.equal(chain.ok, true);
    let pose = { position: { x: 0, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    for (const link of chain.transforms) {
        pose = composeRep103Poses(link, pose);
    }
    // Ego at Three (10,0,0) = REP (10,0,0). Camera mount (1.5,0,0.5).
    // Optical +Z is mount +X, so 2 m along optical Z lands at x=13.5, z=0.5.
    assert.ok(Math.abs(pose.position.x - 13.5) < 1e-6, JSON.stringify(pose.position));
    assert.ok(Math.abs(pose.position.y) < 1e-6, JSON.stringify(pose.position));
    assert.ok(Math.abs(pose.position.z - 0.5) < 1e-6, JSON.stringify(pose.position));

    const runtime = new CandidateOutputRuntime({ transformRuntime: tf });
    const [box] = normalizeDetections3D(
        detection3dPayload({ frameId: "front_camera_optical_frame", position: { x: 0, y: 0, z: 2 } }),
        { source: "candidate", metadata: { frameId: "front_camera_optical_frame", captureTimeNs: 0 }, transformToMap: runtime._transformToMapBinder(0) },
    );
    assert.equal(box.status, VISUALIZATION_STATUS.OK);
    assert.ok(Math.abs(box.box3d.center.x - 13.5) < 1e-6);
    assert.ok(Math.abs(box.box3d.center.z - 0.5) < 1e-6);
});

test("normalizeOdometry exposes covariance ellipse radii", () => {
    const payload = buildNativeOdometry();
    payload.poseCovariance[0] = 0.25;
    payload.poseCovariance[7] = 1;
    const estimate = normalizeOdometry(payload, { valueContract: { id: "cev.odometry", version: 1 }, metadata: { frameId: "map", captureTimeNs: 0 } });
    assert.equal(estimate.covarianceEllipse.sigmaX, 0.5);
    assert.equal(estimate.covarianceEllipse.sigmaY, 1);
});

test("candidate output runtime publishes visualization without activating downstream", () => {
    const store = new SignalStore({}, { sourceId: "candidate-runtime" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const runtime = new CandidateOutputRuntime({ telemetry: store, manifest });
    const topic = topicFromContract("perception-detections-3d");
    const payload = detection3dPayload({ position: { x: 1, y: 0, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.8 } });
    const routed = router.routeInbound({
        name: topic.name,
        valueContract: topic.valueContract, metadata: { frameId: "map", captureTimeNs: 0 },
        value: payload,
    }, { applyStep: 2, applyTimeNs: 33_333_334, arrivalTimeNs: 33_333_334 });
    runtime.ingestRouted(routed, { applyStep: 2, applyTimeNs: 33_333_334 });
    assert.equal(routed.ok, true);
    assert.equal(store.read("active.topics.perception-detections-3d")?.exists, false);
    assert.equal(store.read("visualization.perception.candidate")?.value?.detections3d?.length, 1);
    assert.equal(store.read("visualization.perception.status")?.value?.status, VISUALIZATION_STATUS.OK);
});

test("stale localization ghosts last-good estimate in visualization", () => {
    const store = new SignalStore({}, { sourceId: "stale-runtime" });
    const manifest = createDefaultRunManifest();
    const estimate = manifest.topics.find((entry) => entry.contractId === "localization-estimate");
    estimate.timeoutNs = 1_000;
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const runtime = new CandidateOutputRuntime({ telemetry: store, manifest });
    const payload = buildNativeOdometry();
    payload.pose.position.x = 3;
    const ok = router.routeInbound({
        name: estimate.name,
        valueContract: estimate.valueContract, metadata: { frameId: "map", captureTimeNs: 0 },
        value: payload,
    }, { applyStep: 1, applyTimeNs: 1_000_000, arrivalTimeNs: 1_000_000 });
    runtime.ingestRouted(ok, { applyStep: 1, applyTimeNs: 1_000_000 });

    const stale = router.routeInbound({
        name: estimate.name,
        valueContract: estimate.valueContract, metadata: { frameId: "map", captureTimeNs: 0 },
        value: payload,
    }, { applyStep: 2, applyTimeNs: 5_000_000, arrivalTimeNs: 1_000_000 });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale");
    runtime.ingestRouted(stale, { applyStep: 2, applyTimeNs: 5_000_000 });
    assert.equal(store.read("visualization.localization.candidate")?.value?.status, VISUALIZATION_STATUS.STALE);
    assert.equal(store.read("visualization.localization.candidate")?.value?.estimate?.position?.x, 3);
});

test("LogDataset capture-time lookback reports age", () => {
    const dataset = new LogDataset("test", { metadata: {}, durationUs: 2_000_000 }, {
        schemas: new Map([
            ["visualization.perception.candidate", { id: 1, path: "visualization.perception.candidate", type: "json" }],
        ]),
        updates: [
            {
                path: "visualization.perception.candidate",
                timeUs: 1_000_000,
                cycle: 1,
                value: { captureTimeNs: 1_000_000_000, detections3d: [{ id: "a" }], detections2d: [], lanes: [] },
            },
        ],
        events: [],
        checkpoints: [],
        attachments: [],
    });
    const hit = dataset.valueAtCaptureTime("visualization.perception.candidate", 1_500_000_000);
    assert.equal(hit.matched, true);
    assert.equal(hit.ageNs, 500_000_000);
    assert.equal(hit.value.detections3d[0].id, "a");
    const exactMiss = dataset.valueAtCaptureTime("visualization.perception.candidate", 1_500_000_000, { exactSync: true });
    assert.equal(exactMiss.matched, false);
});
