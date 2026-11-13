import assert from "node:assert/strict";
import test from "node:test";
import { listRegisteredSchemaTypes, parseMsgDefinition } from "../app/client/TopicCodec.js";
import {
    assertProtobufInterfaceResource, bindProtobufRunKeys, createProtobufInterfaceResource,
    normalizeProtobufRunConfig, planProtobufRouteAdmission,
} from "../app/interfaces/ProtobufRunBinding.js";
import { protobufRunFixture } from "./helpers/protobufRunFixture.js";

function admit(manifest, resource, options = {}) {
    return planProtobufRouteAdmission({ manifest, interfaceResource: resource, ...options });
}

test("protobuf run selection is explicit and rejects operational fields", () => {
    assert.deepEqual(normalizeProtobufRunConfig(), { mode: "disabled", interfaceHash: null, externalController: false });
    for (const value of [null, { mode: "other" }, { mode: "zenoh" }, { mode: "disabled", interfaceHash: "a".repeat(64) },
        { externalController: true }, { externalController: "false" }, { endpoints: [] }, { sourceId: "moving" }]) {
        assert.throws(() => normalizeProtobufRunConfig(value));
    }
});

test("route admission uses isolated schema roots and native scalar topic values", () => {
    const { manifest, resource: original } = protobufRunFixture();
    const topic = manifest.topics.find((topic) => topic.id === "vehicle-state");
    topic.type = topic.schema.type = "std_msgs/Float64";
    const document = structuredClone(original.document);
    document.routes.find((route) => route.id === "state").mapping.fields[0].from = "value";
    const resource = createProtobufInterfaceResource(document);
    manifest.protobuf.interfaceHash = resource.hash;
    const before = structuredClone({ manifest, resource });
    const registered = listRegisteredSchemaTypes();
    const plan = admit(manifest, resource);
    assert.equal(plan.routes.length, 2);
    assert.equal(plan.schemas.get("main").root.lookupType("run_test.State").fields.speed_mps.type, "double");
    assert.deepEqual(listRegisteredSchemaTypes(), registered);
    assert.deepEqual({ manifest, resource }, before);
    assert.deepEqual(parseMsgDefinition("test/Outer", "uint8[] bytes\nInner child\nuint32 LIMIT=3"), [
        { name: "bytes", typeName: "uint8", isArray: true, arrayLen: null },
        { name: "child", typeName: "test/Inner", isArray: false, arrayLen: null },
    ]);
});

test("route admission rejects absent topics, direction, local paths and metadata paths", () => {
    for (const mutate of [
        (manifest) => { manifest.topics = manifest.topics.filter((topic) => topic.id !== "vehicle-state"); },
        (manifest) => { manifest.topics.find((topic) => topic.id === "vehicle-state").direction = "input"; },
        (_manifest, document) => { document.routes.find((route) => route.id === "state").mapping.fields[0].from = "value.data"; },
        (_manifest, document) => { document.routes.find((route) => route.id === "state").mapping.fields[1].from = "metadata.unknown"; },
        (_manifest, document) => { document.routes.find((route) => route.id === "state").mapping.fields[2].from = "run.missing"; },
        (_manifest, document) => { document.routes.find((route) => route.id === "state").mapping.fields[0].from = "metadata.frameId"; },
    ]) {
        const { manifest, resource } = protobufRunFixture();
        const document = structuredClone(resource.document);
        mutate(manifest, document);
        const changed = createProtobufInterfaceResource(document);
        manifest.protobuf.interfaceHash = changed.hash;
        assert.throws(() => admit(manifest, changed));
    }
});

test("local subscriber fields, constants, arrays and scalar conversions are checked", () => {
    const { manifest, resource } = protobufRunFixture({ inbound: true });
    admit(manifest, resource);
    for (const fields of [[{ to: "missing", from: "value.speed_mps" }], [{ to: "speed", value: "fast" }],
        [{ to: "mode", from: "value.speed_mps", scale: 1 }], [{ to: "header.stamp.nanosec", value: -1 }]]) {
        const document = structuredClone(resource.document);
        document.routes.find((route) => route.id === "command").mapping.fields = fields;
        const changed = createProtobufInterfaceResource(document);
        manifest.protobuf.interfaceHash = changed.hash;
        assert.throws(() => admit(manifest, changed));
    }
    const bytes = protobufRunFixture();
    bytes.manifest.topics.find((topic) => topic.id === "vehicle-state").type = "std_msgs/Byte";
    bytes.manifest.topics.find((topic) => topic.id === "vehicle-state").schema.type = "std_msgs/Byte";
    const doc = structuredClone(bytes.resource.document);
    doc.routes.find((route) => route.id === "state").mapping.fields = [{ to: "data", from: "value" }];
    bytes.resource = createProtobufInterfaceResource(doc);
    bytes.manifest.protobuf.interfaceHash = bytes.resource.hash;
    admit(bytes.manifest, bytes.resource);
});

test("named adapters require an available matching contract", () => {
    const { manifest, resource } = protobufRunFixture();
    const document = structuredClone(resource.document);
    document.routes.find((route) => route.id === "state").mapping = { adapter: "state-v1", config: { scale: 1 } };
    const changed = createProtobufInterfaceResource(document);
    manifest.protobuf.interfaceHash = changed.hash;
    assert.throws(() => admit(manifest, changed), /adapter contract/);
    const adapters = new Map([["state-v1", { direction: "publish", localType: "geometry_msgs/Vector3", messageType: "run_test.State",
        validateConfig(config) { assert.equal(config.scale, 1); } }]]);
    admit(manifest, changed, { adapters });
});

test("external control requires one explicit candidate owner", () => {
    for (const mutate of [
        (manifest) => { manifest.protobuf.externalController = false; },
        (manifest) => { manifest.controls.authority = "reference"; },
        (manifest) => { manifest.topics.find((topic) => topic.id === "controls-command").producer = "reference"; },
        (manifest) => { manifest.topics.find((topic) => topic.id === "controls-command").routeDownstream = false; },
    ]) {
        const { manifest, resource } = protobufRunFixture({ inbound: true });
        mutate(manifest);
        assert.throws(() => admit(manifest, resource), /candidate|external-controller/);
    }
    const { manifest, resource } = protobufRunFixture();
    manifest.protobuf.externalController = true;
    assert.throws(() => admit(manifest, resource), /one candidate/);
    const multiple = protobufRunFixture({ inbound: true });
    const document = structuredClone(multiple.resource.document);
    document.routes.push({ ...document.routes.find((route) => route.id === "command"), id: "second", key: "second" });
    const changed = createProtobufInterfaceResource(document);
    multiple.manifest.protobuf.interfaceHash = changed.hash;
    assert.throws(() => admit(multiple.manifest, changed), /multiple subscriptions/);
});

test("concrete key binding checks actual collisions and does not mutate templates", () => {
    const { resource } = protobufRunFixture();
    const document = structuredClone(resource.document);
    document.routes.find((route) => route.id === "spec").key = "sim/colliding/state";
    const changed = createProtobufInterfaceResource(document);
    assert.equal(bindProtobufRunKeys(changed, "isolated").get("state"), "sim/isolated/state");
    assert.throws(() => bindProtobufRunKeys(changed, "colliding"), /concrete run key collides/);
    for (const id of ["../other", "wild*", "", ".", "..", "a".repeat(129)]) assert.throws(() => bindProtobufRunKeys(changed, id));
    assert.equal(changed.document.routes.find((route) => route.id === "state").key, "sim/{run_id}/state");
});

test("resource assertion rejects stale hashes and non-normalized snapshots", () => {
    const { resource } = protobufRunFixture();
    assert.throws(() => assertProtobufInterfaceResource(resource, "f".repeat(64)), /pin/);
    const modified = structuredClone(resource);
    modified.document.bootstrap[0].value.wheelbase_m += 1e-10;
    assert.throws(() => assertProtobufInterfaceResource(modified), /pin/);
    const unsorted = structuredClone(resource);
    unsorted.document.routes.reverse();
    assert.throws(() => assertProtobufInterfaceResource(unsorted), /normalized/);
});
