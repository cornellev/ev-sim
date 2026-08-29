import assert from "node:assert/strict";
import test from "node:test";

import {
    fixturePayloadForType,
    topicFromContract,
} from "../app/autonomy/AutonomyContractCatalog.js";
import {
    normalizeDetections3D,
    normalizeOdometry,
    validateInboundPayload,
    VISUALIZATION_STATUS,
} from "../app/autonomy/AutonomyVisualizationModel.js";
import { CandidateOutputRuntime } from "../app/autonomy/CandidateOutputRuntime.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { LogDataset } from "../app/logging/LogDataset.js";

test("validateInboundPayload rejects non-finite detection geometry", () => {
    const bad = fixturePayloadForType("vision_msgs/Detection3DArray");
    bad.detections = [{
        header: bad.header,
        results: [{ hypothesis: { class_id: "vehicle", score: 1 }, pose: { pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, covariance: new Array(36).fill(0) } }],
        bbox: {
            center: { position: { x: Number.NaN, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
            size: { x: 1, y: 1, z: 1 },
        },
        id: "1",
        visibility: 1,
        occlusion: 0,
    }];
    const result = validateInboundPayload("perception-detections-3d", "vision_msgs/Detection3DArray", bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, "malformed-geometry");
});

test("normalizeDetections3D maps REP-103 centers into three-space", () => {
    const payload = fixturePayloadForType("vision_msgs/Detection3DArray");
    payload.detections = [{
        header: payload.header,
        results: [{ hypothesis: { class_id: "vehicle", score: 0.9 }, pose: { pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, covariance: new Array(36).fill(0) } }],
        bbox: {
            center: { position: { x: 2, y: 1, z: 0.5 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
            size: { x: 4, y: 2, z: 1.5 },
        },
        id: "12",
        visibility: 1,
        occlusion: 0,
    }];
    const [box] = normalizeDetections3D(payload, { source: "candidate" });
    assert.equal(box.box3d.threeCenter.x, 2);
    assert.equal(box.box3d.threeCenter.y, 0.5);
    assert.equal(box.box3d.threeCenter.z, 1);
    assert.equal(box.classId, "vehicle");
});

test("normalizeOdometry exposes covariance ellipse radii", () => {
    const payload = fixturePayloadForType("nav_msgs/Odometry");
    payload.pose.covariance[0] = 0.25;
    payload.pose.covariance[7] = 1;
    const estimate = normalizeOdometry(payload);
    assert.equal(estimate.covarianceEllipse.sigmaX, 0.5);
    assert.equal(estimate.covarianceEllipse.sigmaY, 1);
});

test("candidate output runtime publishes visualization without activating downstream", () => {
    const store = new SignalStore({}, { sourceId: "candidate-runtime" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const runtime = new CandidateOutputRuntime({ telemetry: store, manifest });
    const topic = topicFromContract("perception-detections-3d");
    const payload = fixturePayloadForType("vision_msgs/Detection3DArray");
    payload.detections = [{
        header: payload.header,
        results: [{ hypothesis: { class_id: "barrel", score: 1 }, pose: { pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, covariance: new Array(36).fill(0) } }],
        bbox: {
            center: { position: { x: 1, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
            size: { x: 0.5, y: 0.5, z: 0.8 },
        },
        id: "7",
        visibility: 1,
        occlusion: 0,
    }];
    const routed = router.routeInbound({
        name: topic.name,
        typeStr: topic.schema.type,
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
    const payload = fixturePayloadForType("nav_msgs/Odometry");
    payload.pose.pose.position.x = 3;
    const ok = router.routeInbound({
        name: estimate.name,
        typeStr: estimate.schema.type,
        value: payload,
    }, { applyStep: 1, applyTimeNs: 1_000_000, arrivalTimeNs: 1_000_000 });
    runtime.ingestRouted(ok, { applyStep: 1, applyTimeNs: 1_000_000 });

    const stale = router.routeInbound({
        name: estimate.name,
        typeStr: estimate.schema.type,
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
