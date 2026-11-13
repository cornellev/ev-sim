import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtobufInterfaceStore } from "../../server/storage/ProtobufInterfaceStore.js";

export const protoV1 = 'syntax = "proto3"; package test; message State { double speed_mps = 1; } message Command { double speed_mps = 1; } message Spec { double wheelbase_m = 1; }';
export const protoV2 = 'syntax = "proto3"; package test; message State { double velocity_mps = 1; } message Command { double speed_mps = 1; } message Spec { string wheelbase_m = 1; }';

export function uploadedSource(text = protoV1) {
    return { kind: "uploaded-proto", entryFiles: ["sample.proto"], files: [{ path: "sample.proto", bytesBase64: Buffer.from(text).toString("base64") }] };
}

export function importInput(source = uploadedSource()) {
    return {
        sourceId: "autonomy", schemaId: "main", source,
        bootstrap: [{ id: "spec", schemaId: "main", messageType: "test.Spec", value: { wheelbase_m: 1.7 } }],
        routes: [
            { id: "state", schemaId: "main", messageType: "test.State", direction: "publish", key: "sim/{run_id}/state", source: { topicId: "vehicle-state" }, mapping: { fields: [{ to: "speed_mps", from: "value.speed" }] } },
            { id: "command", schemaId: "main", messageType: "test.Command", direction: "subscribe", key: "sim/{run_id}/command", target: { topicId: "vehicle-control" }, mapping: { fields: [{ to: "speed", from: "value.speed_mps" }] } },
            { id: "spec", schemaId: "main", messageType: "test.Spec", direction: "publish", key: "sim/{run_id}/spec", source: { bootstrapId: "spec" }, mapping: { fields: [] } },
        ],
    };
}

export async function temporaryStore(t, options) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cev-protobuf-store-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return { directory, store: new ProtobufInterfaceStore(directory, options) };
}
