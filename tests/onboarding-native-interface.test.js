import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageService } from "../server/storage/StorageService.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createProtobufInterfaceResource, planProtobufRouteAdmission } from "../app/interfaces/ProtobufRunBinding.js";
import { planNativeRunMigration, applyNativeRunMigration } from "../app/interfaces/NativeRunMigration.js";
import { compileMapping, applyMapping, applyInboundMetadata } from "../app/interfaces/ProtobufMapping.js";
import { buildNativeOdometry } from "../app/simulation/sensors/NativeSensorProducts.js";
import { encodeMessage, decodeMessage } from "../app/interfaces/ProtobufSchema.js";

test("shipped onboarding mappings retain resolved calibration, exact headers, leases, and native paths", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cev-onboarding-interface-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = new StorageService(root);
    const base = await storage.resolveRunManifest("igvc-default");
    const lidar = base.manifest.sensorRig.sensors.find((sensor) => sensor.id === "front-lidar");
    const manifest = createDefaultRunManifest({ version: 12, id: "onboarding", sensorRig: { sensors: [lidar] }, scripts: { enabled: false } });
    const resource = createProtobufInterfaceResource(JSON.parse(await readFile(new URL("../examples/interfaces/onboarding-lease.v2.json", import.meta.url))));
    const source = await storage.resolveRunManifest(manifest.id, manifest);
    const plan = planNativeRunMigration({ manifest, targetInterfaceResource: resource, resolvedRun: source,
        topicContracts: { "controls-command": { id: "cev.control-command", version: 2 } },
        additionalTopics: [{ id: "planning-path", name: "/planning/path", direction: "input", producer: "candidate", authority: "candidate", valueContract: { id: "cev.path", version: 1 } }],
    });
    assert.equal(plan.ok, true, JSON.stringify(plan.blocked));
    const native = applyNativeRunMigration(plan, { expectedRevision: 0 }).manifest;
    await storage.putProtobufInterface(resource.document);
    const resolved = await storage.resolveRunManifest(native.id, native);
    const routes = planProtobufRouteAdmission({ manifest: resolved.manifest, interfaceResource: resource, resolvedRun: resolved }).routes;
    const get = (id) => { const entry = routes.find((entry) => entry.route.id === id); return { entry, compiled: compileMapping(entry, { resolvedRun: resolved, runId: "actual-run" }) }; };
    const metadata = { captureTimeNs: 123, sequenceId: "18446744073709551615" };
    const state = get("state");
    const mapped = applyMapping(state.compiled, { value: buildNativeOdometry({ position: { x: 10, y: 20, z: 0 }, linearVelocity: { x: 2 } }), metadata });
    assert.deepEqual(mapped.header, { run_id: "actual-run", sequence: metadata.sequenceId, time_ns: "123", frame_id: "map" });
    assert.equal(mapped.state.pose.position.x, 10 + state.compiled.bindings.vehicle.rearAxleInBase.x);
    assert.equal(mapped.state.speed_mps, 2);
    const scan = get("lidar");
    const points = applyMapping(scan.compiled, { value: { positions: new Float32Array([1, 2, 3]), intensities: new Float32Array([0.5]), count: 1 }, metadata: { ...metadata, sequenceId: 0 } });
    assert.equal(points.header.sequence, "1");
    assert.equal(points.header.frame_id, "front_lidar_frame");
    assert.deepEqual(points.scan.points, [{ x: 1, y: 2 }]);
    assert.equal(points.scan.sensor_in_vehicle.position.x, scan.compiled.bindings.sensor.poseInRearAxle.position.x);
    const command = get("command");
    assert.equal(command.entry.messageType.fields.control_lease_id.id, 7);
    const wire = { header: { run_id: "actual-run", sequence: "9007199254740993", time_ns: "100", frame_id: "base_link" }, command: { speed_mps: 0.1, steering_rad: 0.05 }, valid_until_ns: "300000100", control_lease_id: "lease" };
    const decoded = decodeMessage(command.entry.messageType, encodeMessage(command.entry.messageType, wire));
    const value = applyMapping(command.compiled, { value: decoded });
    assert.equal(value.leaseId, "lease");
    assert.equal(value.sequence, wire.header.sequence);
    assert.equal(value.deadlineNs, 300000100);
    assert.throws(() => applyMapping(command.compiled, { value: { ...decoded, header: { ...decoded.header, run_id: "other" } } }), /check failed/);
    const pathRoute = get("path");
    const pathValue = { header: { ...wire.header, frame_id: "map" }, path: { points: [{ x: 1, y: 2 }] } };
    assert.deepEqual(applyMapping(pathRoute.compiled, { value: pathValue }), { points: [{ x: 1, y: 2, z: 0 }] });
    assert.deepEqual(applyInboundMetadata(pathRoute.compiled, { value: pathValue }), { runId: "actual-run", frameId: "map", sequenceId: wire.header.sequence, captureTimeNs: 100 });
});
