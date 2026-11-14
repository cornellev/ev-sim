import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtobufInterfaceStore } from "../server/storage/ProtobufInterfaceStore.js";
import { ProtobufInterfaceAuthoringSession, parseInterfaceRoutes, uploadedProtoSource, uploadedDescriptorSource } from "../app/config/protobufInterfaceAuthoring.js";
import { protobufRunFixture } from "./helpers/protobufRunFixture.js";
import { uploadedSource } from "./helpers/protobufFixtures.js";

const resource = protobufRunFixture().resource;
test("imports default to historical interface@1 and explicitly create native interface@2", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cev-import-version-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new ProtobufInterfaceStore(dir);
    const source = uploadedSource('syntax = "proto3"; message State { double speed = 1; }');
    const old = await store.importSources({ sourceId: "old", schemaId: "schema", source }); assert.equal(old.document.version, 1);
    const native = await store.importSources({ sourceId: "native", schemaId: "schema", source, interfaceVersion: 2 }); assert.equal(native.document.version, 2);
    await assert.rejects(store.importSources({ sourceId: "mismatch", schemaId: "second", source, baseHash: native.hash, interfaceVersion: 1 }), /must match/);
});

test("route edits validate schemas, retain exact text, and persist before a run can pin them", async () => {
    const writes = [];
    const session = new ProtobufInterfaceAuthoringSession({ fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); writes.push(body); return { ok: true, json: async () => ({ hash: session.snapshot.hash, document: body.document }) };
    } });
    session.adopt(resource);
    assert.throws(() => parseInterfaceRoutes(resource.document, '{"routes":[],"bootstrap":[],"extra":true}'), /containing/);
    assert.throws(() => session.edit("{")); assert.equal(session.snapshot.text, "{"); assert.equal(session.snapshot.hash, resource.hash);
    const changed = session.edit('{"routes":[],"bootstrap":[]}'); assert.notEqual(changed.hash, resource.hash);
    assert.equal(session.cache.size, 1);
    await session.persist(changed.hash); await session.persist(changed.hash);
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].document.routes, []);
});

test("an old asynchronous selection cannot replace the next run's interface", async () => {
    let resolve;
    const session = new ProtobufInterfaceAuthoringSession({ fetchImpl: () => new Promise((done) => { resolve = done; }) });
    const selecting = session.select(resource.hash); session.reset();
    resolve({ ok: true, json: async () => resource.document }); await selecting;
    assert.equal(session.snapshot.document, null); assert.equal(session.snapshot.busy, false);
});

test("adding an isolated schema persists routing edits before importing against the new revision", async () => {
    const calls = [];
    const source = { id: "tracked", revision: 1, schemaSources: [{ schemaId: "main" }] };
    const session = new ProtobufInterfaceAuthoringSession({ fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); calls.push({ url, body });
        return { ok: true, json: async () => ({ document: session.snapshot.document, hash: session.snapshot.hash,
            source: { ...source, revision: calls.length + 1 } }) };
    } });
    session.adopt({ ...resource, source }); session.set({ fields: { ...session.snapshot.fields, schemaId: "second" } });
    const changed = session.edit('{"routes":[],"bootstrap":[]}');
    await session.importSource({ kind: "github", url: "https://github.com/test/proto" });
    assert.equal(calls.length, 2); assert.equal(calls[0].body.expectedRevision, 1);
    assert.equal(calls[1].body.baseHash, changed.hash); assert.equal(calls[1].body.expectedRevision, 2);
});

test("uploads preserve relative proto paths and enforce file and descriptor limits", async () => {
    const file = { name: "state.proto", webkitRelativePath: "schemas/state.proto", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    const source = await uploadedProtoSource([file], ["schemas/state.proto"], ["schemas"]);
    assert.equal(source.files[0].path, "schemas/state.proto"); assert.equal(source.files[0].bytesBase64, "AQID");
    await assert.rejects(uploadedProtoSource([{ ...file, size: 1024 * 1024 + 1 }], [], []), /limit/);
    await assert.rejects(uploadedDescriptorSource({ size: 700001 }), /700,000/);
});
