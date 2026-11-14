import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDetections2D, normalizeDetections3D, normalizeOdometry, normalizeControlsSnapshot } from "../app/autonomy/AutonomyVisualizationModel.js";
import { CandidateOutputRuntime } from "../app/autonomy/CandidateOutputRuntime.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { topicFromNativeContract } from "../app/simulation/NativeTopicCatalog.js";
import { buildNativeOdometry } from "../app/simulation/sensors/NativeSensorProducts.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";

test("native visual geometry uses sample frames, time, and exact sequence", () => {
    const metadata = { frameId: "world", captureTimeNs: 10, sequenceId: "18446744073709551615" };
    const common = { id: "box", classId: "vehicle", score: 0.9, visibility: 1, occlusion: 0 };
    const [box2] = normalizeDetections2D({ detections: [{ ...common, center: { x: 2, y: 3 }, size: { x: 4, y: 5 } }] }, { valueContract: { id: "cev.detections-2d", version: 1 }, metadata });
    assert.equal(box2.box2d.center.y, 3);
    assert.equal(box2.captureTimeNs, 10);
    const [box3] = normalizeDetections3D({ detections: [{ ...common, pose: { position: { x: 2, y: 3, z: 4 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, size: { x: 1, y: 2, z: 3 } }] }, { valueContract: { id: "cev.detections-3d", version: 1 }, metadata });
    assert.deepEqual(box3.box3d.threeCenter, { x: 2, y: 4, z: -3 });
    assert.equal(box3.frameId, "world");
    const pose = normalizeOdometry(buildNativeOdometry({ position: { x: 2 } }), { valueContract: { id: "cev.odometry", version: 1 }, metadata });
    assert.equal(pose.position.x, 2);
    assert.equal(pose.captureTimeNs, 10);
    assert.equal(normalizeControlsSnapshot({ sequence: metadata.sequenceId }).sequence, metadata.sequenceId);
});

test("native candidate localization aligns with sample-time truth and paths retain their identity", () => {
    const topics = ["truth-odometry", "localization-estimate", "planning-path"].map((id) => topicFromNativeContract(id));
    const telemetry = new SignalStore();
    const router = new TopicContractRouter({ id: "run", version: 13, topics }, { telemetry, publicationPort: () => true });
    const runtime = new CandidateOutputRuntime({ telemetry, manifest: { topics } });
    router.routeOutbound("truth-odometry", { value: buildNativeOdometry({ position: { x: 3 } }) }, { captureTimeNs: 10, deliveryTimeNs: 10, frameId: "world", sequenceId: "1", producer: "oracle" });
    const routed = router.routeInbound({ name: "localization-estimate", value: buildNativeOdometry({ position: { x: 3 } }), metadata: { frameId: "world", captureTimeNs: 10, sequenceId: "2" }, captureTimeNs: 10 }, { applyStep: 2, applyTimeNs: 20 });
    const snapshot = runtime.ingestRouted(routed, { applyStep: 2, applyTimeNs: 20 });
    assert.equal(snapshot.truth.captureTimeNs, 10);
    assert.equal(snapshot.error.positionM, 0);
    const path = router.routeInbound({ name: "planning-path", value: { points: [{ x: 1, y: 2, z: 3 }] }, metadata: { frameId: "world", captureTimeNs: 11, sequenceId: "9007199254740993" }, captureTimeNs: 11 }, { applyStep: 3, applyTimeNs: 30 });
    runtime.ingestRouted(path, { applyStep: 3, applyTimeNs: 30 });
    assert.equal(runtime.lastPath.sequenceId, "9007199254740993");
    assert.deepEqual(runtime.lastPath.points[0].three, { x: 1, y: 3, z: -2 });
});
