import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProtobufInterfaceStore } from "../server/storage/ProtobufInterfaceStore.js";
import { importInput, protoV1, protoV2, temporaryStore, uploadedSource } from "./helpers/protobufFixtures.js";

test("ZPB-02 previews all broken routes and bootstrap values, then adopts only valid routes offline", async (t) => {
    const { directory, store } = await temporaryStore(t);
    const original = await store.importSources(importInput());
    const preview = await store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: 1, source: uploadedSource(protoV2) });
    assert.deepEqual(preview.invalidatedRoutes.map(({ route }) => route.id), ["spec", "state"]);
    assert.deepEqual(preview.invalidatedBootstrap.map(({ bootstrap }) => bootstrap.id), ["spec"]);
    assert.ok(preview.invalidatedRoutes.every((entry) => entry.issues.length));
    assert.equal((await store.getSource("autonomy")).interfaceHash, original.hash);
    assert.equal(await store.getByHash(preview.candidateHash), null);
    await assert.rejects(store.applyUpdate("autonomy", { checkId: preview.checkId, expectedRevision: preview.revision }), { code: "PROTOBUF_INVALIDATION_ACCEPTANCE_REQUIRED" });
    const fresh = new ProtobufInterfaceStore(directory, { fetchImpl() { throw new Error("offline"); } });
    const applied = await fresh.applyUpdate("autonomy", { checkId: preview.checkId, expectedRevision: preview.revision, acceptInvalidations: true });
    assert.deepEqual(applied.document.routes.map((route) => route.id), ["command"]);
    assert.deepEqual(applied.document.bootstrap, []);
    assert.equal(applied.source.invalidatedRoutes.length, 2);
    assert.deepEqual(await fresh.getByHash(original.hash), original.document);
    assert.equal((await fresh.applyUpdate("autonomy", { checkId: preview.checkId, expectedRevision: preview.revision, acceptInvalidations: true })).unchanged, true);
    const repaired = structuredClone(applied.document);
    repaired.routes.push({ ...original.document.routes.find((route) => route.id === "state"), mapping: { fields: [{ to: "velocity_mps", from: "value.speed" }] } });
    const saved = await fresh.putImmutable(repaired, { sourceId: "autonomy", expectedRevision: applied.source.revision });
    assert.deepEqual(saved.source.invalidatedRoutes.map(({ route }) => route.id), ["spec"]);
});

test("ZPB-02 never reactivates disabled definitions during later updates", async (t) => {
    const { store } = await temporaryStore(t);
    await store.importSources(importInput());
    const broken = await store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: 1, source: uploadedSource(protoV2) });
    const applied = await store.applyUpdate("autonomy", { checkId: broken.checkId, expectedRevision: 2, acceptInvalidations: true });
    const restored = await store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: applied.source.revision, source: uploadedSource(protoV1) });
    const next = await store.applyUpdate("autonomy", { checkId: restored.checkId, expectedRevision: restored.revision });
    assert.deepEqual(next.document.routes.map((route) => route.id), ["command"]);
    assert.equal(next.source.invalidatedRoutes.length, 2);
});

test("ZPB-02 rejects stale previews and concurrent checks", async (t) => {
    const { store } = await temporaryStore(t);
    await store.importSources(importInput());
    const checks = await Promise.allSettled([1, 2].map(() => store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: 1, source: uploadedSource(protoV2) })));
    assert.equal(checks.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(checks.find((result) => result.status === "rejected").reason.code, "PROTOBUF_REVISION_CONFLICT");
    const check = checks.find((result) => result.status === "fulfilled").value;
    const current = await store.getSource("autonomy");
    await store.putImmutable(await store.getByHash(current.interfaceHash), { sourceId: "autonomy", expectedRevision: current.revision });
    await assert.rejects(store.applyUpdate("autonomy", { checkId: check.checkId, expectedRevision: current.revision + 1, acceptInvalidations: true }), { code: "PROTOBUF_REVISION_CONFLICT" });
});

test("ZPB-02 failed checks and failed adoption keep the previous pointer and receipts", async (t) => {
    const faults = {};
    const { store, directory } = await temporaryStore(t, { faults });
    const original = await store.importSources(importInput());
    const file = path.join(directory, "protobuf-interfaces", "sources", "autonomy.json");
    const previous = await readFile(file, "utf8");
    await assert.rejects(store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: 1, source: uploadedSource('syntax = "proto2";') }), { code: "PROTOBUF_ACQUISITION_FAILED" });
    assert.equal(await readFile(file, "utf8"), previous);
    const check = await store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: 1, source: uploadedSource(protoV2) });
    const pending = await readFile(file, "utf8");
    faults.write = () => { throw new Error("disk full"); };
    const request = { checkId: check.checkId, expectedRevision: check.revision, acceptInvalidations: true };
    await assert.rejects(store.applyUpdate("autonomy", request), { code: "PROTOBUF_IO" });
    assert.equal(await readFile(file, "utf8"), pending);
    delete faults.write;
    faults.sourceWrite = () => { throw new Error("pointer write failed"); };
    await assert.rejects(store.applyUpdate("autonomy", request), { code: "PROTOBUF_IO" });
    assert.equal(await readFile(file, "utf8"), pending);
    assert.deepEqual(await store.getByHash(original.hash), original.document);
    delete faults.sourceWrite;
    assert.equal((await store.applyUpdate("autonomy", request)).hash, check.candidateHash);
});

test("ZPB-02 a lost commit acknowledgement is recoverable by retrying the same check", async (t) => {
    const faults = {};
    const { store } = await temporaryStore(t, { faults });
    await store.importSources(importInput());
    const preview = await store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: 1, source: uploadedSource(`${protoV1}\n// new source revision`) });
    const before = await store.getSource("autonomy");
    assert.equal(preview.candidateHash, before.interfaceHash);
    assert.notEqual(preview.candidateSource.files[0].sha256, before.schemaSources[0].files[0].sha256);
    faults.sourceCommitted = () => { throw new Error("lost acknowledgement"); };
    const request = { checkId: preview.checkId, expectedRevision: preview.revision };
    await assert.rejects(store.applyUpdate("autonomy", request), { code: "PROTOBUF_IO" });
    delete faults.sourceCommitted;
    const retried = await store.applyUpdate("autonomy", request);
    assert.equal(retried.unchanged, true);
    assert.equal(retried.source.lastUpdate.checkId, preview.checkId);
});
