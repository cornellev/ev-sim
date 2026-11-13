import { createDefaultRunManifest } from "../../app/simulation/RunManifest.js";
import { createProtobufInterfaceResource } from "../../app/interfaces/ProtobufRunBinding.js";
import { loadUploadedProtoFiles } from "../../server/interfaces/ProtobufSourceLoader.js";
import { uploadedSource } from "./protobufFixtures.js";

export const runProto = 'syntax = "proto3"; package run_test; message State { double speed_mps = 1; uint64 time_ns = 2; string run_id = 3; bytes data = 4; } message Command { double speed_mps = 1; } message Spec { double wheelbase_m = 1; map<string, double> coefficients = 2; }';
const schema = await loadUploadedProtoFiles(uploadedSource(runProto));

export function protobufRunFixture({ inbound = false } = {}) {
    const document = {
        kind: "cev-sim.protobuf-interface", version: 1,
        schemas: [{ id: "main", fingerprint: schema.fingerprint, descriptorBase64: schema.descriptorBase64 }],
        routes: [{ id: "state", schemaId: "main", messageType: "run_test.State", direction: "publish", key: "sim/{run_id}/state",
            source: { topicId: "vehicle-state" }, mapping: { fields: [{ to: "speed_mps", from: "value.x" }, { to: "time_ns", from: "metadata.simTimeNs" }, { to: "run_id", from: "run.runId" }] } },
        ...(inbound ? [{ id: "command", schemaId: "main", messageType: "run_test.Command", direction: "subscribe", key: "sim/{run_id}/command",
            target: { topicId: "controls-command" }, mapping: { fields: [{ to: "speed", from: "value.speed_mps" }] } }] : []),
        { id: "spec", schemaId: "main", messageType: "run_test.Spec", direction: "publish", key: "sim/{run_id}/spec",
            source: { bootstrapId: "spec" }, mapping: { fields: [] } }],
        bootstrap: [{ id: "spec", schemaId: "main", messageType: "run_test.Spec", value: { wheelbase_m: 1.7, coefficients: { "10": 1e-7, "2": 1 + 1e-10 } } }],
    };
    const resource = createProtobufInterfaceResource(document);
    const manifest = createDefaultRunManifest({ id: "protobuf-run", sensorRig: { sensors: [] }, scripts: { enabled: false } });
    manifest.topics.push({ id: "vehicle-state", name: "/vehicle-state", direction: "output", type: "geometry_msgs/Vector3", schema: { type: "geometry_msgs/Vector3", version: 1 }, producer: "simulator", authority: "reference" });
    manifest.protobuf = { mode: "zenoh", interfaceHash: resource.hash, externalController: inbound };
    return { manifest, resource };
}
