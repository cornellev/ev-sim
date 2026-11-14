import { readFile } from "node:fs/promises";
import { createProtobufInterfaceResource } from "../../app/interfaces/ProtobufRunBinding.js";
import { loadUploadedProtoFiles } from "../../server/interfaces/ProtobufSourceLoader.js";
import { uploadedSource } from "./protobufFixtures.js";
import { createHeadlessImu, rehashRunBundle } from "./headlessRunnerBundle.js";
import { createStateSensorBackendSelection } from "../../app/simulation/sensors/StateSensorBackend.js";
import { HeadlessZenohRuntime } from "../../server/headless/HeadlessZenohRuntime.js";
import { ZenohNativeTransport } from "../../server/sensor-transports/ZenohNativeTransport.js";
import { createNativeTopicContractResource } from "../../app/simulation/NativeTopicContracts.js";

export const controllerSchema = await loadUploadedProtoFiles(uploadedSource(`syntax = "proto3"; package headless_test;
message Command { string run=1; uint64 sequence=2; uint64 capture=3; uint64 deadline=4; double speed=5; double steering=6; string lease=7; }
message State { uint64 time=1; string run=2; double speed=3; uint64 sequence=4; }`));

export async function externalBundle({ maxSteps = 24, sensors = true, leased = false } = {}) {
    const bundle = JSON.parse(await readFile(new URL("../fixtures/protobuf/run-controls.v13.json", import.meta.url), "utf8"));
    const manifest = bundle.resolved.manifest;
    if (leased) manifest.topics.find((topic) => topic.id === "controls-command").valueContract.version = 2;
    manifest.clock.maxSteps = maxSteps;
    manifest.sensorRig.sensors = sensors ? [createHeadlessImu({ frameId: "imu", outputs: { imuTopicId: "imu" } }),
        createHeadlessImu({ id: "wheel", type: "wheel-odometry", frameId: "odom", outputs: { odometryTopicId: "wheel-odometry" },
            calibration: { wheelRadius: 0.15, ticksPerRevolution: 1024, trackWidth: 1.2, slipFactor: 0,
                poseNoise: { x: 0, y: 0, z: 0 }, twistNoise: { x: 0, y: 0, z: 0 }, childFrameId: "base_link" } })] : [];
    if (sensors) bundle.resolved.backendSelections.push(createStateSensorBackendSelection());
    const resource = createProtobufInterfaceResource({ kind: "cev-sim.protobuf-interface", version: 2,
        schemas: [{ id: "main", fingerprint: controllerSchema.fingerprint, descriptorBase64: controllerSchema.descriptorBase64 }], bootstrap: [],
        routes: [
            { id: "command", schemaId: "main", messageType: "headless_test.Command", direction: "subscribe", key: "sim/{run_id}/command", target: { topicId: "controls-command" },
                mapping: { fields: [
                    ...Object.entries({ runId: "run", sequence: "sequence", captureTimeNs: "capture", deadlineNs: "deadline", speedMps: "speed", steeringRad: "steering" }).map(([to, from]) => ({ to, from: `value.${from}` })),
                    ...(leased ? [{ to: "leaseId", from: "value.lease" }] : []),
                    ...Object.entries({ mode: "velocity", frameId: "base_link", accelerationMps2: 0, jerkMps3: 0, steeringRateRadps: 0 }).map(([to, value]) => ({ to, value })),
                ] } },
            { id: "clock", schemaId: "main", messageType: "headless_test.State", direction: "publish", key: "sim/{run_id}/clock", source: { topicId: "clock" },
                mapping: { fields: [{ to: "time", from: "value.timeNs" }, { to: "run", from: "run.runId" }] } },
            ...(sensors ? [{ id: "imu", schemaId: "main", messageType: "headless_test.State", direction: "publish", key: "sim/{run_id}/imu", source: { topicId: "imu" },
                mapping: { fields: [{ to: "time", from: "metadata.captureTimeNs" }, { to: "run", from: "run.runId" }, { to: "sequence", from: "metadata.sequenceId" }, { to: "speed", from: "value.angularVelocity.z" }] } },
            { id: "wheel", schemaId: "main", messageType: "headless_test.State", direction: "publish", key: "sim/{run_id}/wheel", source: { topicId: "wheel-odometry" },
                mapping: { fields: [{ to: "time", from: "metadata.captureTimeNs" }, { to: "run", from: "run.runId" }, { to: "sequence", from: "metadata.sequenceId" }, { to: "speed", from: "value.linearVelocity.x" }] } }] : []),
        ] });
    bundle.resolved.protobufInterface = resource;
    manifest.protobuf.interfaceHash = resource.hash;
    bundle.resolved.dependencyHashes.protobufInterface = resource.hash;
    bundle.resolved.nativeTopicContracts = createNativeTopicContractResource(manifest.topics);
    bundle.resolved.dependencyHashes.nativeTopicContracts = bundle.resolved.nativeTopicContracts.hash;
    return rehashRunBundle(bundle);
}

export function fakeZenohBinding() {
    const sessions = [];
    return { sessions, createSession(json, wake) {
        const session = { config: JSON.parse(json), packets: [], incoming: [], generation: 0, state: "created", rejected: false,
            async openSession() { this.state = "open"; },
            publish(key, bytes, routeId, generation, required) {
                if (this.rejected) return { ok: false, code: "queue-full", fatal: required };
                this.packets.push({ key, bytes: new Uint8Array(bytes), routeId, generation }); return { ok: true };
            },
            async subscribe() { return 1; }, async unsubscribe() {},
            async reset(generation) { this.generation = generation; this.incoming = []; },
            drainInbound() { return this.incoming.splice(0); },
            diagnostics() { return JSON.stringify({ available: this.state === "open", state: this.state, zenohVersion: "1.10.2", shmProviderAvailable: true, transports: [{ shm: true }], queueBytes: 0, queueEntries: 0 }); },
            async close() { this.state = "closed"; },
            receive(bytes, generation = this.generation) { this.incoming.push({ routeId: "command", bytes, generation }); wake(); },
        };
        sessions.push(session);
        return session;
    } };
}

export function zenohRuntimeFactory(nativeBinding) {
    return (options) => new HeadlessZenohRuntime({ ...options, transportFactory: (transportOptions) => new ZenohNativeTransport({ ...transportOptions, nativeBinding }) });
}
