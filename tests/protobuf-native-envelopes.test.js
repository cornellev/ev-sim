import assert from "node:assert/strict";
import test from "node:test";
import { loadUploadedProtoFiles } from "../server/interfaces/ProtobufSourceLoader.js";
import { uploadedSource } from "./helpers/protobufFixtures.js";
import { createProtobufInterfaceResource, planProtobufRouteAdmission, protobufInputContractHash } from "../app/interfaces/ProtobufRunBinding.js";
import { compileMapping, applyMapping, applyInboundMetadata } from "../app/interfaces/ProtobufMapping.js";
import { normalizeMappingDefinition } from "../app/interfaces/ProtobufMappingDefinition.js";
import { ProtobufRouteRuntime } from "../app/interfaces/ProtobufRouteRuntime.js";
import { encodeMessage } from "../app/interfaces/ProtobufSchema.js";
import { getNativeTopicContract, normalizeNativeTopic, validateNativeTopicValue, createNativeTopicContractResource } from "../app/simulation/NativeTopicContracts.js";
import { normalizeControlCommand } from "../app/autonomy/ControlCommand.js";

const schema = await loadUploadedProtoFiles(uploadedSource('syntax="proto3"; package envelope_test; message Point {double x=1;double y=2;double z=3;} message Input {string run=1;string frame=2;uint64 capture=3;uint64 sequence=4;repeated Point points=5;int64 signed_value=6;}'));
const type = schema.root.lookupType("envelope_test.Input");
function fixture() {
    const topic = { id: "path", name: "/path", direction: "input", producer: "candidate", valueContract: { id: "cev.path", version: 1 } };
    const route = { id: "path", schemaId: "main", messageType: "envelope_test.Input", direction: "subscribe", key: "envelope/{run_id}/path", target: { topicId: topic.id }, mapping: {
        fields: [{ to: "points", each: { from: "value.points", fields: ["x", "y", "z"].map((name) => ({ to: name, from: `item.${name}` })) } }],
        metadata: [{ to: "runId", from: "value.run" }, { to: "frameId", from: "value.frame" }, { to: "captureTimeNs", from: "value.capture" }, { to: "sequenceId", from: "value.sequence" }],
        checks: [{ from: "value.run", equalsFrom: "run.runId" }, { from: "value.frame", value: "world" }],
    } };
    const resource = createProtobufInterfaceResource({ kind: "cev-sim.protobuf-interface", version: 2, schemas: [{ id: "main", fingerprint: schema.fingerprint, descriptorBase64: schema.descriptorBase64 }], routes: [route], bootstrap: [] });
    return { version: 13, manifest: { version: 13, id: "run", topics: [topic], protobuf: { mode: "zenoh", interfaceHash: resource.hash, externalController: false } }, protobufInterface: resource, nativeTopicContracts: createNativeTopicContractResource([topic]) };
}

test("native contract resources retain both command versions without changing v1 shapes", () => {
    const topic = { id: "command", name: "/command", direction: "input", producer: "candidate", valueContract: { id: "cev.control-command", version: 1 } };
    const v1 = createNativeTopicContractResource([topic]);
    const both = createNativeTopicContractResource([topic, { ...topic, id: "leased", valueContract: { id: "cev.control-command", version: 2 } }]);
    assert.deepEqual(both.document.contracts.map(({ version }) => version), [1, 2]);
    assert.deepEqual(both.document.contracts[0], v1.document.contracts[0]);
    assert.equal(Object.hasOwn(getNativeTopicContract("cev.control-command").shape.fields, "leaseId"), false);
    assert.throws(() => normalizeNativeTopic({ ...topic, valueContract: { id: "cev.control-command" } }), /exact/);
    assert.throws(() => getNativeTopicContract("cev.path", 2), /Unavailable/);
    const command = { runId: "run", mode: "velocity", sequence: "18446744073709551615", captureTimeNs: 1, deadlineNs: 2, frameId: "base_link", speedMps: 0.1, accelerationMps2: 0, jerkMps3: 0, steeringRad: 0, steeringRateRadps: 0, leaseId: "lease" };
    assert.equal(normalizeControlCommand(command, { runId: "run", applyTimeNs: 1, valueContract: { id: "cev.control-command", version: 2 } }).command.leaseId, "lease");
    assert.equal(validateNativeTopicValue("cev.control-command", command).ok, false);
    assert.equal(validateNativeTopicValue({ id: "cev.control-command", version: 2 }, { ...command, leaseId: "" }).ok, false);
});

test("a new owner restarts leased command sequences while path and generic replay fences remain", () => {
    const runtime = new ProtobufRouteRuntime();
    runtime.subscribers = new Map([ ["leased", { route: { id: "leased" }, topicContract: { valueContract: { id: "cev.control-command", version: 2 } } }], ["generic", { route: { id: "generic" }, topicContract: { valueContract: { id: "cev.control-command", version: 1 } } }], ["path", { route: { id: "path" }, topicContract: { valueContract: { id: "cev.path", version: 1 } } }] ]);
    runtime.inboundSequences = new Map([["leased", 10n], ["generic", 10n], ["path", 10n]]);
    runtime.resetControlSequences();
    assert.equal(runtime.inboundSequences.has("leased"), false);
    assert.equal(runtime.inboundSequences.get("generic"), 10n);
    assert.equal(runtime.inboundSequences.get("path"), 10n);
});

test("typed mapping checks and metadata retain precision and reject invalid sources", () => {
    const resolved = fixture();
    const entry = planProtobufRouteAdmission({ manifest: resolved.manifest, interfaceResource: resolved.protobufInterface, resolvedRun: resolved }).routes[0];
    const compiled = compileMapping(entry, { resolvedRun: resolved, runId: "actual-run" });
    const input = { value: { run: "actual-run", frame: "world", capture: "99", sequence: "18446744073709551615", points: [{ x: 1, y: 2, z: 3 }] } };
    assert.deepEqual(applyInboundMetadata(compiled, input), { runId: "actual-run", frameId: "world", captureTimeNs: 99, sequenceId: "18446744073709551615" });
    assert.deepEqual(applyMapping(compiled, input), { points: [{ x: 1, y: 2, z: 3 }] });
    assert.throws(() => applyMapping(compiled, { value: { ...input.value, frame: "vehicle" } }), /check failed/);
    assert.throws(() => applyInboundMetadata(compiled, { value: { ...input.value, capture: "9007199254740993" } }), /narrowing/);
    assert.throws(() => normalizeMappingDefinition({ fields: [], metadata: [{ to: "applyTimeNs", value: 1 }] }), /metadata/);
    assert.throws(() => normalizeMappingDefinition({ fields: [], checks: [{ from: "value.run", value: "run", equalsFrom: "run.runId" }] }), /selects/);
    assert.throws(() => compileMapping({ ...entry, route: { ...entry.route, mapping: { ...entry.route.mapping, checks: [{ from: "value.points", value: [] }] } } }), /scalar/);
    const signed = compileMapping({ ...entry, route: { ...entry.route, mapping: { ...entry.route.mapping, checks: [{ from: "value.signed_value", value: "-9223372036854775808" }] } } });
    applyMapping(signed, { value: { ...input.value, signed_value: "-9223372036854775808" } });
});

test("inbound capture identity survives queueing, rejects replays, and resets", () => {
    const runtime = new ProtobufRouteRuntime();
    runtime.configure({ resolvedRun: fixture(), runId: "actual" });
    const input = { run: "actual", frame: "world", capture: "99", sequence: "9007199254740993", points: [] };
    const receive = (value, options = {}) => runtime.acceptInbound("path", encodeMessage(type, value), { clock: { step: 1, timeNs: 100 }, ...options });
    assert.equal(receive(input).accepted, true);
    const queued = runtime.inputQueue.queue[0];
    assert.equal(queued.applyStep, 2);
    assert.equal(queued.info.captureTimeNs, 99);
    assert.equal(queued.info.sequence, input.sequence);
    assert.equal(queued.info.metadata.frameId, "world");
    assert.equal(receive(input).accepted, false);
    assert.equal(receive({ ...input, run: "other" }).accepted, false);
    assert.equal(receive({ ...input, capture: "101", sequence: "9007199254740994" }).accepted, false);
    assert.equal(receive({ ...input, sequence: "9007199254740994" }, { queueLimits: { maxEntries: 1 } }).accepted, false);
    runtime.inputQueue.reset();
    assert.equal(receive({ ...input, sequence: "9007199254740994" }).accepted, true);
    runtime.reset();
    assert.equal(receive(input).accepted, true);
});

test("frozen run values in checks and metadata are included in subscription identity", () => {
    const resolved = fixture();
    const document = structuredClone(resolved.protobufInterface.document);
    document.routes[0].mapping.checks.push({ from: "value.frame", equalsFrom: "run.manifest.expectedFrame" });
    resolved.manifest.expectedFrame = "world";
    resolved.protobufInterface = createProtobufInterfaceResource(document);
    resolved.manifest.protobuf.interfaceHash = resolved.protobufInterface.hash;
    const before = protobufInputContractHash(resolved);
    resolved.manifest.expectedFrame = "other";
    assert.notEqual(protobufInputContractHash(resolved), before);
});
