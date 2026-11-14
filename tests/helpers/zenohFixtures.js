import { loadUploadedProtoFiles } from "../../server/interfaces/ProtobufSourceLoader.js";
import { createProtobufInterfaceResource } from "../../app/interfaces/ProtobufRunBinding.js";
import { uploadedSource } from "./protobufFixtures.js";

export const zenohSchema = await loadUploadedProtoFiles(uploadedSource('syntax = "proto3"; package zenoh_test; message Image { bytes data=1; uint32 width=2; uint32 height=3; string pixelFormat=4; uint32 strideBytes=5; } message Envelope { Image image=1; bytes duplicate=2; uint64 time=3; }'));
export const zenohHostConfig = () => ({ kind: "cev-sim.zenoh-transport-host-config", version: 1, connect: ["tcp/127.0.0.1:7447"] });

export function imageRun({ width = 128, height = 128, fields = [{ to: "image", from: "value" }], derived = [], required = false } = {}) {
    const topic = { id: "image", name: "/image", direction: "output", producer: "simulator", required, valueContract: { id: "cev.image", version: 1 } };
    const resource = createProtobufInterfaceResource({ kind: "cev-sim.protobuf-interface", version: 2,
        schemas: [{ id: "main", fingerprint: zenohSchema.fingerprint, descriptorBase64: zenohSchema.descriptorBase64 }], bootstrap: [],
        routes: [{ id: "image", schemaId: "main", messageType: "zenoh_test.Envelope", direction: "publish", key: "sim/{run_id}/image", source: { topicId: "image" }, mapping: { fields, derived } }] });
    return { version: 13, manifest: { version: 13, id: "image-run", protobuf: { mode: "zenoh", interfaceHash: resource.hash, externalController: false },
        topics: [topic], sensorRig: { rootFrameId: "base_link", sensors: [{ id: "camera", type: "camera", outputs: { imageTopicId: "image" },
            calibration: { width, height, products: { rgb: true } } }] } }, protobufInterface: resource };
}
