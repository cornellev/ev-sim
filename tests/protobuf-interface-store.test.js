import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtobufInterfaceStore } from "../server/storage/ProtobufInterfaceStore.js";
import { loadDescriptorFile, loadProtoFiles, loadUploadedProtoFiles } from "../server/interfaces/ProtobufSourceLoader.js";
import { importInput, temporaryStore, uploadedSource } from "./helpers/protobufFixtures.js";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/protobuf/${name}`, import.meta.url));

test("ZPB-02 immutable interfaces deduplicate, survive restart, and return independent values", async (t) => {
    const { directory, store } = await temporaryStore(t);
    const imported = await store.importSources(importInput());
    const copies = await Promise.all(Array.from({ length: 4 }, () => store.putImmutable(imported.document)));
    assert.ok(copies.every((copy) => copy.hash === imported.hash));
    const fresh = new ProtobufInterfaceStore(directory);
    const document = await fresh.getByHash(imported.hash);
    document.routes[0].key = "changed";
    assert.deepEqual(await fresh.getByHash(imported.hash), imported.document);
    assert.equal((await fresh.list()).interfaces.length, 1);
    assert.equal(await fresh.getByHash("0".repeat(64)), null);
    await assert.rejects(fresh.getByHash("../bad"), { code: "PROTOBUF_INVALID" });
    const text = await readFile(path.join(directory, "protobuf-interfaces", "sha256", `${imported.hash}.json`), "utf8");
    assert.equal(text.includes("schemaSources"), false);
    assert.equal(text.includes("origin"), false);
});

test("ZPB-02 refuses corrupted immutable content instead of overwriting it", async (t) => {
    const { directory, store } = await temporaryStore(t);
    const imported = await store.importSources(importInput());
    const file = path.join(directory, "protobuf-interfaces", "sha256", `${imported.hash}.json`);
    await writeFile(file, JSON.stringify({ ...imported.document, routes: [] }));
    await assert.rejects(store.getByHash(imported.hash), { code: "PROTOBUF_CORRUPT" });
    await assert.rejects(store.putImmutable(imported.document), { code: "PROTOBUF_CORRUPT" });
    assert.deepEqual(JSON.parse(await readFile(file)), { ...imported.document, routes: [] });
});

test("ZPB-02 source acquisition preserves compiler fingerprints and exact consumed-byte digests", async (t) => {
    const { store } = await temporaryStore(t);
    const proto = fixture("features/features.proto");
    const local = await loadProtoFiles([proto]);
    const files = await Promise.all(["features.proto", "common.proto"].map(async (name) => ({ path: name, bytesBase64: (await readFile(fixture(`features/${name}`))).toString("base64") })));
    const upload = await loadUploadedProtoFiles({ entryFiles: ["features.proto"], files });
    assert.equal(local.fingerprint, upload.fingerprint);
    assert.equal(local.files.length, 2);
    assert.equal(local.files.some((file) => file.importPath.startsWith("google/")), false);
    assert.deepEqual(local.files.map(({ sha256 }) => sha256), upload.files.map(({ sha256 }) => sha256));
    const imported = await store.importSources({ sourceId: "features", schemaId: "features", source: { kind: "local-proto", entryFiles: [proto] } });
    assert.deepEqual(imported.source.schemaSources[0].files, local.files);
    const binary = fixture("onboarding/autonomy.binpb");
    const descriptor = await loadDescriptorFile(binary);
    const second = await store.importDescriptor({ sourceId: "features", schemaId: "onboarding", expectedRevision: 1, source: { kind: "descriptor", filePath: binary } });
    assert.equal(second.document.schemas.length, 2);
    assert.equal(second.document.schemas.find((schema) => schema.id === "onboarding").fingerprint, descriptor.fingerprint);
    await assert.rejects(store.importDescriptor({ sourceId: "features", schemaId: "third", expectedRevision: 1, source: { kind: "descriptor", descriptorBase64: descriptor.descriptorBase64 } }), { code: "PROTOBUF_REVISION_CONFLICT" });
    const direct = await store.importDescriptor({ sourceId: "descriptor", schemaId: "main", source: { kind: "descriptor", descriptorBase64: descriptor.descriptorBase64 } });
    assert.equal(direct.source.schemaSources[0].files[0].sha256, descriptor.fingerprint);
});

test("ZPB-02 rejects invalid uploads, untrusted request fields, and unsafe source IDs", async (t) => {
    const { store } = await temporaryStore(t);
    const original = await store.importSources(importInput());
    const bad = uploadedSource();
    bad.files.push(bad.files[0]);
    await assert.rejects(store.importSources({ sourceId: "bad", schemaId: "main", source: bad }), { code: "PROTOBUF_ACQUISITION_FAILED" });
    const invalidUtf8 = uploadedSource();
    invalidUtf8.files[0].bytesBase64 = Buffer.from([255]).toString("base64");
    await assert.rejects(store.importSources({ sourceId: "bad", schemaId: "main", source: invalidUtf8 }), { code: "PROTOBUF_ACQUISITION_FAILED" });
    await assert.rejects(store.importSources({ sourceId: "bad", schemaId: "main", source: { ...uploadedSource(), token: "secret" } }), { code: "PROTOBUF_INVALID" });
    await assert.rejects(store.importSources({ sourceId: "../bad", schemaId: "main", source: uploadedSource() }), { code: "PROTOBUF_INVALID" });
    assert.equal(await store.getSource("bad"), null);
    assert.deepEqual(await store.getSource("autonomy"), original.source);
    await assert.rejects(store.importSources({ sourceId: "bad", schemaId: "main", baseHash: "", source: uploadedSource() }), { code: "PROTOBUF_INVALID" });
});

test("ZPB-02 tracked document edits preserve schema pins and repair disabled drafts explicitly", async (t) => {
    const { store } = await temporaryStore(t);
    const original = await store.importSources(importInput());
    const edit = structuredClone(original.document);
    edit.routes[0].key = "sim/{run_id}/new-command";
    const saved = await store.putImmutable(edit, { sourceId: "autonomy", expectedRevision: 1 });
    assert.equal(saved.source.revision, 2);
    assert.equal((await store.getSource("autonomy")).interfaceHash, saved.hash);
    await assert.rejects(store.putImmutable(edit, { sourceId: "autonomy", expectedRevision: 1 }), { code: "PROTOBUF_REVISION_CONFLICT" });
    const other = await store.importSources({ sourceId: "other", schemaId: "main", source: uploadedSource('syntax = "proto3"; package changed; message Value {}') });
    await assert.rejects(store.putImmutable({ ...saved.document, schemas: other.document.schemas }, { sourceId: "autonomy", expectedRevision: 2 }), { code: "PROTOBUF_INVALID" });
});

test("ZPB-02 uploaded closures enforce the aggregate byte limit even for unused files", async () => {
    const source = uploadedSource();
    source.files = Array.from({ length: 9 }, (_, index) => ({ path: `unused${index}.proto`, bytesBase64: Buffer.alloc(1024 * 1024, 32).toString("base64") }));
    await assert.rejects(loadUploadedProtoFiles(source), /too large/);
});
