import assert from "node:assert/strict";
import test from "node:test";
import { loadUploadedProtoFiles } from "../server/interfaces/ProtobufSourceLoader.js";
import { uploadedSource } from "./helpers/protobufFixtures.js";
import { createProtobufInterfaceResource, planProtobufRouteAdmission } from "../app/interfaces/ProtobufRunBinding.js";
import { ProtobufRouteRuntime } from "../app/interfaces/ProtobufRouteRuntime.js";
import { compileMapping, applyMapping } from "../app/interfaces/ProtobufMapping.js";
import { decodeMessage, encodeMessage } from "../app/interfaces/ProtobufSchema.js";
import { getNativeTopicContract, validateNativeTopicValue, createNativeTopicContractResource, assertNativeTopicContractResource } from "../app/simulation/NativeTopicContracts.js";
import { TopicInputQueue, estimatePayloadBytes } from "../app/simulation/TopicInputQueue.js";
import { ControlRuntime } from "../app/autonomy/ControlRuntime.js";
import { buildNativePoints, buildNativeOdometry, buildNativeImage } from "../app/simulation/sensors/NativeSensorProducts.js";
import { buildLidarCapture } from "../app/simulation/sensors/LidarProducts.js";
import { SeededRNG } from "../app/util/SeededRNG.js";
import { SensorPublisher } from "../app/simulation/sensors/SensorPublisher.js";
import { SensorPublisher as BrowserSensorPublisher } from "../app/3d/devices/SensorPublisher.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { bindNativeProductContext, frameTransform, poseAtOffset } from "../app/interfaces/NativeProductTransforms.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";

const schema = await loadUploadedProtoFiles(uploadedSource('syntax = "proto3"; package native_test; message Point { float x=1; float y=2; float z=3; float intensity=4; } message Sample { double speed=1; uint64 sequence=2; uint64 time=3; string run=4; repeated Point points=5; optional double presence=6; bytes data=7; }'));
const type = schema.root.lookupType("native_test.Sample");
const commandFields = [{ to: "speedMps", from: "value.speed" }, { to: "sequence", from: "value.sequence" }, { to: "captureTimeNs", from: "value.time" }, { to: "runId", from: "value.run" },
    ...Object.entries({ mode: "velocity", deadlineNs: 0, frameId: "base_link", accelerationMps2: 0, jerkMps3: 0, steeringRad: 0, steeringRateRadps: 0 }).map(([to, value]) => ({ to, value }))];
export function nativeFixture() {
    const topics = [{ id: "state", name: "/state", direction: "output", valueContract: { id: "cev.odometry", version: 1 }, producer: "simulator", authority: "reference", routeDownstream: false },
        { id: "points", name: "/points", direction: "output", valueContract: { id: "cev.points", version: 1 }, producer: "simulator", routeDownstream: false },
        { id: "controls-command", contractId: "controls-command", name: "/controls/command", direction: "input", valueContract: { id: "cev.control-command", version: 1 }, producer: "candidate", authority: "candidate", routeDownstream: true }];
    const resource = createProtobufInterfaceResource({ kind: "cev-sim.protobuf-interface", version: 2,
        schemas: [{ id: "main", fingerprint: schema.fingerprint, descriptorBase64: schema.descriptorBase64 }],
        bootstrap: [{ id: "boot", schemaId: "main", messageType: "native_test.Sample", value: { speed: 2 }, repeatMs: 10 }],
        routes: [
            { id: "state", schemaId: "main", messageType: "native_test.Sample", direction: "publish", key: "sim/{run_id}/state", source: { topicId: "state" }, mapping: { fields: [{ to: "speed", from: "value.linearVelocity.x" }, { to: "run", from: "run.runId" }, { to: "time", from: "metadata.captureTimeNs" }] } },
            { id: "points", schemaId: "main", messageType: "native_test.Sample", direction: "publish", key: "sim/{run_id}/points", source: { topicId: "points" }, mapping: { fields: [{ to: "points", each: { from: "value.points", fields: ["x", "y", "z", "intensity"].map((name) => ({ to: name, from: `item.${name}` })) } }] } },
            { id: "command", schemaId: "main", messageType: "native_test.Sample", direction: "subscribe", key: "sim/{run_id}/command", target: { topicId: "controls-command" }, mapping: { fields: commandFields } },
            { id: "boot", schemaId: "main", messageType: "native_test.Sample", direction: "publish", key: "sim/{run_id}/boot", source: { bootstrapId: "boot" }, mapping: { fields: [] } },
        ] });
    const manifest = { kind: "cev-sim.run-manifest", version: 13, id: "native-run", topics, controls: { authority: "candidate", targetVehicleId: "ego" }, protobuf: { mode: "zenoh", interfaceHash: resource.hash, externalController: true } };
    return { version: 13, manifest, protobufInterface: resource, nativeTopicContracts: createNativeTopicContractResource(topics) };
}

test("native contracts reject malformed products and pin an exact resource", () => {
    const resolved = nativeFixture();
    assertNativeTopicContractResource(resolved.nativeTopicContracts, resolved.manifest.topics);
    assert.throws(() => getNativeTopicContract("unknown"));
    assert.equal(validateNativeTopicValue("cev.image", buildNativeImage({ data: new Uint8Array(4), width: 1, height: 1 })).ok, true);
    assert.equal(validateNativeTopicValue("cev.points", { positions: [1, 2], intensities: [1], count: 1 }).ok, false);
    assert.equal(validateNativeTopicValue("cev.transforms", { transforms: [{ parentFrameId: "map", childFrameId: "base_link", pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 2 } } }] }).ok, false);
    const modified = structuredClone(resolved.nativeTopicContracts); modified.document.contracts[0].shape = {};
    assert.throws(() => assertNativeTopicContractResource(modified, resolved.manifest.topics));
});

test("native control ownership follows the contract, independent of topic naming", () => {
    const resolved = nativeFixture();
    const topic = resolved.manifest.topics.find((topic) => topic.id === "controls-command");
    topic.name = "/drive"; delete topic.contractId;
    resolved.manifest.protobuf.externalController = false;
    assert.throws(() => planProtobufRouteAdmission({ manifest: resolved.manifest, interfaceResource: resolved.protobufInterface, resolvedRun: resolved }), /external-controller/);
    resolved.manifest.protobuf.externalController = true;
    planProtobufRouteAdmission({ manifest: resolved.manifest, interfaceResource: resolved.protobufInterface, resolvedRun: resolved });
});

test("root assignments map native scalars and reject byte coercion", () => {
    const document = nativeFixture().protobufInterface.document;
    document.routes[0].mapping = { fields: [{ to: "", value: { speed: 3 } }] };
    assert.deepEqual(createProtobufInterfaceResource(document).document.routes[0].mapping.fields[0].value, { speed: 3 });
    document.routes[0].mapping.fields.push({ to: "speed", value: 4 });
    assert.throws(() => createProtobufInterfaceResource(document), /Overlapping/);
    const topicContract = { id: "scalar", name: "/scalar", direction: "input", producer: "candidate", valueContract: { id: "cev.scalar-f64", version: 1 } };
    const route = { id: "scalar", direction: "subscribe", mapping: { fields: [{ to: "", from: "value.speed" }] } };
    const compiled = compileMapping({ route, messageType: type, topicContract });
    assert.equal(applyMapping(compiled, { value: { speed: 3 } }), 3);
    assert.equal(applyMapping(compiled, { value: {} }), 0);
    topicContract.valueContract.id = "cev.bytes";
    route.mapping.fields = [{ to: "", value: [256] }];
    assert.throws(() => compileMapping({ route, messageType: type, topicContract }), /Byte mapping/);
    route.mapping.fields = [{ to: "", from: "value.data" }];
    assert.deepEqual(applyMapping(compileMapping({ route, messageType: type, topicContract }), { value: { data: new Uint8Array([0, 255]) } }), new Uint8Array([0, 255]));
});

test("compiled repeated projection owns output and preserves exact integers and presence", () => {
    const resolved = nativeFixture();
    const admission = planProtobufRouteAdmission({ manifest: resolved.manifest, interfaceResource: resolved.protobufInterface, resolvedRun: resolved });
    const points = admission.routes.find((entry) => entry.route.id === "points").compiled;
    const value = { positions: new Float32Array([1, 2, 3]), intensities: new Float32Array([0.5]), count: 1 };
    const output = applyMapping(points, { value }); value.positions.fill(0);
    assert.deepEqual(output, { points: [{ x: 1, y: 2, z: 3, intensity: 0.5 }] });
    const command = admission.routes.find((entry) => entry.route.id === "command").compiled;
    assert.equal(applyMapping(command, { value: { sequence: "18446744073709551615", run: "native-run", time: "1" } }).sequence, "18446744073709551615");
    assert.equal(applyMapping(command, { value: { sequence: "1", run: "native-run" } }).speedMps, 0);
    assert.throws(() => applyMapping(command, { value: { sequence: "1", run: "native-run", time: "9007199254740993" } }), /narrowing/);
    const route = structuredClone(admission.routes.find((entry) => entry.route.id === "state").route);
    route.mapping = { fields: [{ to: "speed", from: "value.pose.orientation", operation: "quaternionYaw" }] };
    const yaw = compileMapping({ route, messageType: type, topicContract: resolved.manifest.topics[0] });
    assert.ok(Math.abs(applyMapping(yaw, { value: buildNativeOdometry({ orientation: { z: Math.SQRT1_2, w: Math.SQRT1_2 } }) }).speed - Math.PI / 2) < 1e-12);
});

test("vehicle bindings and rigid transforms use explicit geometry", () => {
    const manifest = createDefaultVehicleManifest();
    const resolved = { vehicles: [{ actorId: "ego", manifest }] };
    assert.throws(() => bindNativeProductContext({ vehicleId: "missing" }, resolved));
    const bound = bindNativeProductContext({ vehicleId: "ego", rearWheelIds: ["rear-left", "rear-right"] }, resolved);
    assert.equal(bound.vehicle.rearAxleInBase.x, -0.75);
    assert.throws(() => bindNativeProductContext({ vehicleId: "ego", rearWheelIds: ["front-left", "front-right"] }, resolved));
    resolved.calibration = { frames: { map: "map", baseLink: "base_link" }, sensors: [{ id: "sensor", parentId: "ego", poseReference: "map", mountFrameId: "sensor", measurementFrameId: "sensor", pose: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 } } }] };
    const mounted = bindNativeProductContext({ sensorId: "sensor" }, resolved);
    assert.equal(mounted.sensor.rootFrameId, "map"); assert.equal(mounted.sensor.poseInBase, undefined);
    assert.deepEqual(mounted.sensor.poseInMap.position, { x: 1, y: 2, z: 3 });
    assert.throws(() => bindNativeProductContext({ vehicleId: "ego", sensorId: "sensor" }, resolved), /Map-mounted/);
    delete resolved.calibration.sensors[0].poseReference;
    assert.equal(bindNativeProductContext({ vehicleId: "ego", sensorId: "sensor" }, resolved).sensor.rootFrameId, "base_link");
    const base = { position: { x: 1, y: 2, z: 0 }, orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } };
    const shifted = poseAtOffset(base, { x: 1, y: 0, z: 0 });
    assert.ok(Math.abs(shifted.position.y - 3) < 1e-12);
    const world = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    const recovered = frameTransform(shifted.position, world, base);
    assert.ok(Math.abs(recovered.x - 1) < 1e-12);
    assert.throws(() => poseAtOffset({ ...base, orientation: { x: 0, y: 0, z: 0, w: 2 } }, { x: 1, y: 0, z: 0 }));
});

test("runtime bootstrap coalesces simulation intervals and resets generation", () => {
    const resolved = nativeFixture(), packets = [];
    const runtime = new ProtobufRouteRuntime({ publicationPort: (packet) => { packets.push(packet); return true; } });
    runtime.configure({ resolvedRun: resolved });
    const generation = runtime.generation;
    runtime.deliver({ step: 0, timeNs: 0 }); runtime.deliver({ step: 0, timeNs: 0 });
    runtime.deliver({ step: 1, timeNs: 45_000_000 }); runtime.deliver({ step: 1, timeNs: 45_000_000 });
    assert.equal(packets.length, 2); assert.deepEqual(decodeMessage(type, packets[0].bytes), { speed: 2 });
    runtime.reset(); runtime.deliver({ step: 0, timeNs: 0 }); assert.equal(packets.length, 3);
    assert.equal(runtime.acceptInbound("command", new Uint8Array(), { generation, clock: { step: 0, timeNs: 0 } }).code, "stale-generation");
    runtime.dispose(); assert.equal(runtime.publishTopic({ topicId: "state" }).ok, false);
});

test("runtime rejects ambiguous subscription key and route selectors", () => {
    const resolved = nativeFixture(), document = resolved.protobufInterface.document;
    resolved.manifest.topics.push({ id: "scalar", name: "/scalar", direction: "input", producer: "candidate", valueContract: { id: "cev.scalar-f64", version: 1 } });
    document.routes.push({ id: "second", schemaId: "main", messageType: "native_test.Sample", direction: "subscribe", key: "command", target: { topicId: "scalar" }, mapping: { fields: [{ to: "", from: "value.speed" }] } });
    resolved.protobufInterface = createProtobufInterfaceResource(document); resolved.manifest.protobuf.interfaceHash = resolved.protobufInterface.hash;
    assert.throws(() => new ProtobufRouteRuntime().configure({ resolvedRun: resolved }), /key collides/);
});

test("browser and headless delivery produce identical native mapped bytes", () => {
    const outputs = [];
    for (const Publisher of [BrowserSensorPublisher, SensorPublisher]) {
        const resolved = nativeFixture(), packets = [];
        const routes = new ProtobufRouteRuntime({ publicationPort: (packet) => { packets.push(packet); return true; } });
        routes.configure({ resolvedRun: resolved });
        const store = new SignalStore();
        const publisher = new Publisher({ telemetryId: "sensor" }, { id: "sensor", rateHz: 100, outputs: {}, latency: { fixedNs: 0, jitterNs: 0 } }, {
            nativeTopics: true, topics: resolved.manifest.topics, stepNs: 10_000_000, runtimeData: { bindings: () => ({ signalStore: store }) },
            publicationPort: (envelope) => routes.publishTopic(envelope), encodeTopicValue: () => { throw new Error("Unexpected ROS encoding"); },
        });
        publisher.enqueue([{ topicId: "state", signal: "odometry", frameId: "base_link", value: buildNativeOdometry({ linearVelocity: { x: 2 } }) }], 0, 0, new SeededRNG("same"));
        publisher.deliver({ step: 1, timeNs: 10_000_000 });
        assert.equal(publisher.health.publishedFrames, 1); assert.equal(packets.length, 1);
        outputs.push(packets[0].bytes);
        publisher.dispose(); routes.dispose();
    }
    assert.deepEqual(outputs[0], outputs[1]);
});

test("inbound admission is bounded and command application keeps exact ordering", () => {
    const resolved = nativeFixture();
    const queue = new TopicInputQueue(resolved.manifest.topics, { maxEntries: 1 });
    const runtime = new ProtobufRouteRuntime({ inputQueue: queue }); runtime.configure({ resolvedRun: resolved });
    const bytes = encodeMessage(type, { speed: 1, sequence: "9007199254740993", run: "native-run" });
    const clock = { step: 0, timeNs: 0 };
    const accepted = runtime.acceptInbound("command", bytes, { clock });
    assert.equal(accepted.applied, false); assert.equal(accepted.applyStep, 1);
    assert.equal(runtime.acceptInbound("command", bytes, { clock }).code, "queue-full");
    assert.equal(queue.drain(0).length, 0);
    const info = queue.drain(1)[0].info;
    const controls = new ControlRuntime({ manifest: resolved.manifest });
    const boundControls = new ControlRuntime({ manifest: resolved.manifest, runId: "connection-run" });
    assert.equal(boundControls.ingestCommand(info).code, "run-mismatch");
    assert.equal(boundControls.ingestCommand({ ...info, value: { ...info.value, runId: "connection-run" } }).ok, true);
    assert.equal(controls.ingestCommand(info).ok, true);
    controls.step({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(controls.getSnapshot().sequence, "9007199254740993");
    assert.equal(controls.ingestCommand(info).code, "sequence-regression");
    assert.equal(controls.ingestCommand({ value: { ...info.value, sequence: "9007199254740994", runId: "another" } }).code, "run-mismatch");
    assert.equal(controls.ingestCommand({ value: { ...info.value, sequence: "9007199254740994", frameId: "map" } }).code, "invalid-frame");
    assert.ok(estimatePayloadBytes({ nested: { first: new Uint8Array(900_000), second: new Uint8Array(900_000) } }) > 1_800_000);
});

test("native point products match legacy measured points in a single RNG pass", () => {
    const buffer = new Float32Array([5, 0.5, 1, 1, 7, 0.2, 1, 2]);
    const config = { calibration: { range: 20, azimuth: { startDeg: 0, endDeg: 2, stepDeg: 1 }, elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 }, products: { pointCloud: true } },
        noise: { model: "gaussian", bias: 0.1, standardDeviation: 0.1, pointDropoutProbability: 0.2 }, outputs: { pointCloudTopicId: "points" }, frameId: "lidar" };
    const capture = (nativeTopics) => buildLidarCapture({ buffer, config, captureTimeNs: 0, rng: new SeededRNG("same"), publisher: { nativeTopics }, includeObservation: true });
    const legacy = capture(false), native = capture(true), view = new DataView(legacy.messages[0].value.data.buffer);
    assert.deepEqual(native.observation, legacy.observation);
    for (let index = 0; index < native.messages[0].value.count; index++) for (let axis = 0; axis < 3; axis++) assert.equal(native.messages[0].value.positions[index * 3 + axis], view.getFloat32(index * 16 + axis * 4, true));
    assert.equal(validateNativeTopicValue("cev.points", buildNativePoints({ buffer, calibration: config.calibration })).ok, true);
});
