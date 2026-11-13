import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import descriptor from "protobufjs/ext/descriptor/index.js";
import { decodeMessage, encodeMessage, loadDescriptorSet, PROTOBUF_LIMITS } from "../app/interfaces/ProtobufSchema.js";
import { hashProtobufInterface, normalizeProtobufInterface, validateProtobufInterface } from "../app/interfaces/ProtobufInterface.js";
import { loadDescriptorFile, loadProtoFiles, PROTOBUF_SOURCE_LIMITS } from "../server/interfaces/ProtobufSourceLoader.js";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/protobuf/${name}`, import.meta.url));
const onboarding = await loadDescriptorFile(fixture("onboarding/autonomy.binpb"));
const features = await loadProtoFiles([fixture("features/features.proto")]);
const sample = features.root.lookupType("tests.protobuf.Sample");
const descriptorBytes = (file) => descriptor.FileDescriptorSet.encode({ file: Array.isArray(file) ? file : [file] }).finish();
const simpleFile = () => ({ name: "simple.proto", syntax: "proto3", package: "test", messageType: [{ name: "Value", field: [{ name: "count", number: 1, label: 1, type: 13 }] }] });

async function directory(t) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cev-protobuf-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

function document() {
    return {
        kind: "cev-sim.protobuf-interface", version: 1,
        schemas: [{ id: "onboarding", fingerprint: onboarding.fingerprint, descriptorBase64: onboarding.descriptorBase64 }],
        bootstrap: [{ id: "spec", schemaId: "onboarding", messageType: "cev.onboarding.v1.VehicleSpec", value: { wheelbase_m: 1.7 } }],
        routes: [
            { id: "state", schemaId: "onboarding", messageType: "cev.onboarding.v1.StateUpdate", direction: "publish", key: "sim/{run_id}/state", source: { topicId: "vehicle-state" }, mapping: { fields: [{ to: "header.time_ns", from: "metadata.simTimeNs" }, { to: "state.speed_mps", from: "value.speed", scale: 1, offset: 0 }] } },
            { id: "command", schemaId: "onboarding", messageType: "cev.onboarding.v1.CommandUpdate", direction: "subscribe", key: "sim/{run_id}/command", target: { topicId: "vehicle-control" }, mapping: { fields: [{ to: "speed", from: "value.command.speed_mps" }] } },
            { id: "spec", schemaId: "onboarding", messageType: "cev.onboarding.v1.VehicleSpec", direction: "publish", key: "sim/{run_id}/spec", source: { bootstrapId: "spec" }, mapping: { fields: [] } },
        ],
    };
}

test("onboarding descriptor bytes and exact 64-bit identity remain unchanged", async () => {
    assert.equal(onboarding.fingerprint, "d3002f3091ed00f14441f5158f78f6935df72f802024e0341a56f57e9f39c87c");
    assert.deepEqual(Buffer.from(onboarding.descriptorBase64, "base64"), await readFile(fixture("onboarding/autonomy.binpb")));
    const type = onboarding.root.lookupType("cev.onboarding.v1.Header");
    const value = { run_id: "r1", sequence: "18446744073709551615", time_ns: "9007199254740993", frame_id: "body" };
    assert.deepEqual(decodeMessage(type, encodeMessage(type, value)), value);
});

test("both reference source packages compile in isolated roots with original field names", async () => {
    const original = await loadProtoFiles([fixture("onboarding/autonomy.proto")]);
    const cev = await loadProtoFiles([fixture("cev-interfaces/proto/cev_interfaces.proto"), fixture("cev-interfaces/proto/cev/interfaces/v1/common.proto")], { includeDirs: [fixture("cev-interfaces/proto")] });
    const imu = cev.root.lookupType("cev.interfaces.Imu");
    const value = { stamp_ns: 123n, linear_acceleration: { x: 1, y: 2, z: 3 }, angular_velocity: { z: 0.5 } };
    assert.deepEqual(decodeMessage(imu, encodeMessage(imu, value)), { ...value, stamp_ns: "123" });
    const geo = cev.root.lookupType("cev.interfaces.v1.GeoPoint");
    assert.equal(geo.fields.altitude_m.getOption("proto3_optional"), true);
    assert.deepEqual(decodeMessage(geo, encodeMessage(geo, {})), {});
    assert.deepEqual(decodeMessage(geo, encodeMessage(geo, { altitude_m: 0 })), { altitude_m: 0 });
    assert.ok(original.root.lookupType("cev.onboarding.v1.Header"));
    assert.throws(() => cev.root.lookupType("cev.onboarding.v1.Header"));
});

test("modular source closure retains filenames, public imports, and optional presence", async () => {
    const second = await loadProtoFiles([fixture("features/common.proto"), fixture("features/features.proto")]);
    assert.equal(features.fingerprint, second.fingerprint);
    const set = descriptor.FileDescriptorSet.decode(Buffer.from(features.descriptorBase64, "base64"));
    assert.deepEqual(set.file.map((file) => file.name), ["common.proto", "features.proto", "google/protobuf/timestamp.proto"]);
    const file = set.file.find((file) => file.name === "features.proto");
    assert.deepEqual(file.dependency, ["common.proto", "google/protobuf/timestamp.proto"]);
    assert.deepEqual(file.publicDependency, [0]);
    assert.equal(file.messageType.find((message) => message.name === "Sample").field.find((field) => field.name === "altitude").proto3Optional, true);
    assert.equal(sample.fields.altitude.getOption("proto3_optional"), true);
});

test("codec preserves maps, oneofs, nested arrays, bytes, packing, and integer extremes", () => {
    const value = { time_ns: "18446744073709551615", delta: "-9223372036854775808", enabled: false, data: new Uint8Array([0, 255]), altitude: 0, selected: false, children: [{ x: 2, label: 'import "missing.proto"; {}' }], counters: { left: "9007199254740993" }, indexed: { "18446744073709551615": { x: 5 } }, flags: { left: false }, labels: { true: "yes", false: "no" }, stamp: { seconds: "-1", nanos: 2 }, bins: [1, 2], unpacked: [1, 2], mode: 123 };
    const encoded = encodeMessage(sample, value);
    const decoded = decodeMessage(sample, encoded);
    assert.deepEqual(decoded, value);
    const batch = features.root.lookupType("tests.protobuf.Batch");
    assert.deepEqual(decodeMessage(batch, encodeMessage(batch, { samples: [value] })), { samples: [value] });
    encoded.fill(0);
    assert.deepEqual(decoded.data, new Uint8Array([0, 255]));
    assert.deepEqual([...encodeMessage(sample, { bins: [1, 2], unpacked: [1, 2] })], [114, 2, 1, 2, 120, 1, 120, 2]);
    assert.deepEqual(decodeMessage(sample, encodeMessage(sample, { mode: "MODE_READY", data: "AP8=" })), { mode: 1, data: new Uint8Array([0, 255]) });
});

test("codec rejects lossy values, coercions, invalid fields, and malformed payloads", () => {
    for (const value of [
        { time_ns: Number.MAX_SAFE_INTEGER + 1 }, { time_ns: "18446744073709551616" }, { time_ns: "-1" },
        { delta: "-9223372036854775809" }, { count: 1.5 }, { count: 4294967296 }, { time_ns: "01" },
        { enabled: "false" }, { ratio: Infinity }, { ratio: 1e100 }, { altitude: NaN },
        { mode: "MISSING" }, { selected: false, blob: "" }, { nonexistent: 1 }, { constructor: 1 },
        { children: [, { x: 1 }] }, { counters: { constructor: "1" } }, { data: "???" },
    ]) assert.throws(() => encodeMessage(sample, value));
    assert.throws(() => decodeMessage(sample, new Uint8Array([50, 10, 1])), /range|index/i);
    assert.throws(() => decodeMessage(sample, new Uint8Array(PROTOBUF_LIMITS.payloadBytes + 1)), /bounded/);
    const large = new Uint8Array(PROTOBUF_LIMITS.payloadBytes / 2 + 1);
    assert.throws(() => encodeMessage(sample, { data: large, blob: large }), /too large/);
    assert.throws(() => encodeMessage(sample, { counters: { ["x".repeat(PROTOBUF_LIMITS.payloadBytes + 1)]: "1" } }), /too large/);
});

test("descriptor import closure is mandatory even when an import is unused", () => {
    const file = simpleFile();
    file.dependency = ["missing.proto"];
    assert.throws(() => loadDescriptorSet(descriptorBytes(file)), /Unresolved/);
    const imported = { ...simpleFile(), name: "other.proto", package: "other" };
    const referring = simpleFile();
    referring.messageType[0].field = [{ name: "other", number: 1, label: 1, type: 11, typeName: ".other.Value" }];
    assert.throws(() => loadDescriptorSet(descriptorBytes([referring, imported])), /explicit protobuf import/);
    referring.dependency = ["other.proto"];
    assert.ok(loadDescriptorSet(descriptorBytes([referring, imported])).root.lookupType("test.Value"));
});

test("public imports grant visibility while private transitive imports do not", () => {
    const leaf = { ...simpleFile(), name: "leaf.proto", package: "leaf" };
    const middle = { ...simpleFile(), name: "middle.proto", package: "middle", dependency: ["leaf.proto"] };
    const top = { ...simpleFile(), name: "top.proto", dependency: ["middle.proto"] };
    top.messageType[0].field = [{ name: "leaf", number: 1, label: 1, type: 11, typeName: ".leaf.Value" }];
    assert.throws(() => loadDescriptorSet(descriptorBytes([top, middle, leaf])), /explicit protobuf import/);
    middle.publicDependency = [0];
    assert.ok(loadDescriptorSet(descriptorBytes([top, middle, leaf])));
});

test("descriptor trust boundary rejects unsafe, unsupported, duplicate, and inconsistent definitions", () => {
    const mutations = [
        (file) => { file.name = "../escape.proto"; }, (file) => { file.syntax = "proto2"; },
        (file) => { file.syntax = "editions"; file.edition = 1000; }, (file) => { file.package = "bad..package"; },
        (file) => { file.messageType[0].field[0].name = "__proto__"; },
        (file) => { file.messageType[0].field[0].number = 19000; }, (file) => { file.messageType[0].field[0].label = 2; },
        (file) => { file.messageType[0].field[0].type = 10; }, (file) => { file.messageType[0].field[0].defaultValue = "2"; },
        (file) => { file.messageType[0].field[0].proto3Optional = true; },
        (file) => { file.messageType[0].field[0].oneofIndex = 5; },
        (file) => { file.messageType[0].field.push({ name: "other", number: 1, label: 1, type: 13 }); },
        (file) => { file.messageType[0].extensionRange = [{ start: 1, end: 2 }]; },
        (file) => { file.dependency = ["simple.proto"]; }, (file) => { file.publicDependency = [0]; },
    ];
    for (const mutate of mutations) {
        const file = simpleFile(); mutate(file);
        assert.throws(() => loadDescriptorSet(descriptorBytes(file)));
    }
    assert.throws(() => loadDescriptorSet(descriptorBytes([simpleFile(), simpleFile()])), /Duplicate descriptor file/);
    assert.throws(() => loadDescriptorSet(descriptorBytes([simpleFile(), { ...simpleFile(), name: "duplicate.proto" }])), /Duplicate protobuf definition/);
    assert.throws(() => loadDescriptorSet(new Uint8Array(PROTOBUF_LIMITS.descriptorBytes + 1)), /700000/);
    assert.throws(() => loadDescriptorSet(descriptorBytes(simpleFile()), "0".repeat(64)), /fingerprint/);
});

test("source importer fails on missing imports, cycles, unsafe paths, and unsupported syntax", async (t) => {
    const dir = await directory(t);
    const entry = path.join(dir, "entry.proto");
    for (const source of [
        'syntax = "proto3"; import "missing.proto"; message Value {}',
        'syntax = "proto3"; import "../escape.proto"; message Value {}',
        'syntax = "proto3"; import weak "missing.proto"; message Value {}',
        'syntax = "proto3"; import "entry.proto"; message Value {}',
        'syntax = "proto2"; message Value {}', 'edition = "2023"; message Value {}', 'message Value {}',
        'syntax = "proto3"; syntax = "proto2"; message Value {}',
        'syntax = "proto3"; extend Value { int32 n = 1; } message Value {}',
    ]) {
        await writeFile(entry, source);
        await assert.rejects(loadProtoFiles([entry]));
    }
    await writeFile(entry, new Uint8Array(PROTOBUF_SOURCE_LIMITS.fileBytes + 1));
    await assert.rejects(loadProtoFiles([entry]), /bounded regular file/);
});

test("source importer confines files to roots and rejects ambiguous imports and symlink escapes", async (t) => {
    const dir = await directory(t);
    const left = path.join(dir, "left"); const right = path.join(dir, "right");
    await mkdir(left); await mkdir(right);
    const source = 'syntax = "proto3"; message Value {}';
    await writeFile(path.join(left, "entry.proto"), source);
    await writeFile(path.join(right, "entry.proto"), source);
    await assert.rejects(loadProtoFiles([path.join(left, "entry.proto")], { includeDirs: [left, right] }), /Ambiguous/);
    await assert.rejects(loadProtoFiles([path.join(right, "entry.proto")], { includeDirs: [left] }), /outside/);
    await writeFile(path.join(dir, "outside.proto"), source);
    await symlink(path.join(dir, "outside.proto"), path.join(left, "escape.proto"));
    await assert.rejects(loadProtoFiles([path.join(left, "escape.proto")]), /escapes/);
});

test("interface normalization is deterministic, isolated from inputs, and validates bootstrap types", () => {
    const input = document();
    const before = structuredClone(input);
    const normalized = normalizeProtobufInterface(input);
    assert.deepEqual(normalized.routes.map((route) => route.id), ["command", "spec", "state"]);
    assert.equal(normalized.bootstrap[0].repeatMs, 0);
    assert.deepEqual(input, before);
    assert.equal(hashProtobufInterface(input), hashProtobufInterface({ ...input, routes: [...input.routes].reverse() }));
    normalized.bootstrap[0].value.wheelbase_m = 99;
    assert.equal(input.bootstrap[0].value.wheelbase_m, 1.7);
    assert.equal(validateProtobufInterface(input).ok, true);
    const changed = structuredClone(input); changed.routes[0].key += "-v2";
    assert.notEqual(hashProtobufInterface(changed), hashProtobufInterface(input));
});

test("interface refuses stale fingerprints, unresolved references, unsafe keys, and invalid mapping contracts", () => {
    const mutations = [
        (value) => { value.schemas[0].fingerprint = "0".repeat(64); },
        (value) => { value.schemas[0].descriptorBase64 = "AA==="; },
        (value) => { value.routes.push(structuredClone(value.routes[0])); },
        (value) => { value.routes[0].schemaId = "missing"; }, (value) => { value.routes[0].messageType = "Missing"; },
        (value) => { value.routes[0].key = "sim/**"; }, (value) => { value.routes[0].key = "sim/{unknown}/state"; },
        (value) => { value.routes[0].key = "sim//state"; }, (value) => { value.routes[0].key = value.routes[1].key; },
        (value) => { value.routes[0].target = { topicId: "extra" }; },
        (value) => { value.routes[2].source.bootstrapId = "missing"; },
        (value) => { value.bootstrap[0].value.wheelbase_m = "wrong"; },
        (value) => { value.routes[0].mapping.fields[0].to = "header.missing"; },
        (value) => { value.routes[1].mapping.fields[0].from = "value.command.missing"; },
        (value) => { value.routes[0].mapping.fields[0].from = "process.env.SECRET"; },
        (value) => { value.routes[0].mapping.fields.push({ to: "state", from: "value" }); },
        (value) => { value.routes[0].mapping.fields[0] = { to: "header.run_id", from: "run.id", scale: 2 }; },
        (value) => { value.routes[0].mapping.fields[0] = { to: "header.time_ns", value: Number.MAX_SAFE_INTEGER + 1 }; },
        (value) => { value.routes[0].mapping.adapter = "other"; },
        (value) => { value.routes[0].mapping = { adapter: "custom", config: { tooLarge: "x".repeat(PROTOBUF_LIMITS.payloadBytes + 1) } }; },
        (value) => { value.schemas[0].githubUrl = "https://github.com/example/repo"; },
        (value) => { value.routes = Array(1); }, (value) => { value.version = 2; },
    ];
    for (const mutate of mutations) {
        const value = document(); mutate(value);
        const result = validateProtobufInterface(value);
        assert.equal(result.ok, false, JSON.stringify(value.routes));
        assert.equal(result.document, null);
        assert.equal(result.issues.length, 1);
    }
});
