import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import express from "express";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { loadDescriptorFile } from "../server/interfaces/ProtobufSourceLoader.js";
import { encodeDeterministicArchive, encodeUstarFile, ustarEof, verifyDeterministicArchive } from "../server/artifacts/DeterministicArchive.js";
import { artifactAdapterRegistry } from "../server/marketplace/ArtifactAdapters.js";
import { canonicalMarketplaceBytes } from "../server/marketplace/MarketplaceJson.js";
import { exportRunTemplatePackage, readRunTemplatePackagePreparation, verifyRunTemplatePackage } from "../server/marketplace/RunTemplatePackage.js";
import { LocalRunTemplateImportManager } from "../server/marketplace/client/LocalRunTemplateImportManager.js";
import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { createMarketplaceRouter } from "../server/routes/marketplaceRouter.js";
import { StorageService } from "../server/storage/StorageService.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";
import { makeTriangleGlb, ownedGrant, publishAsset, restrictedGrant, writeRegistry } from "./helpers/visual-assets.js";

async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-local-import-"));
    const source = new StorageService(path.join(directory, "source"));
    const target = new StorageService(path.join(directory, "target"));
    const environment = await source.createEnvironment({ id: "local-yard", name: "Local Yard", supportedEditorSourceVersions: [1] });
    const manifest = await source.createRunManifest(createDefaultRunManifest({ id: "shared-local-run", name: "Shared Local Run", environment: { id: environment.environmentId, expectedHash: null } }));
    const manager = new LocalRunTemplateImportManager(target.dataDir, { storageService: target, pluginStore: target.plugins, editorAssetStore: target.editorAssets, visualAssetStore: target.visualAssets, ...options });
    await manager.recover();
    t.after(async () => { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
    return { directory, source, target, manager, manifest };
}
async function archive(source, manifest, packageVersion = 2, pluginReleaseRefs = []) {
    const exported = await exportRunTemplatePackage({ storageService: source, manifestId: manifest.id, expectedRevision: manifest.revision, packageVersion, pluginReleaseRefs });
    const chunks = [];
    for await (const chunk of exported.stream) chunks.push(chunk);
    await exported.completion;
    return Buffer.concat(chunks);
}
async function wait(manager, id, phase = "complete") {
    for (let attempt = 0; attempt < 500; attempt++) {
        const value = await manager.get(id);
        if (value.phase === phase) return value;
        if (value.phase === "needs-attention" && phase !== "needs-attention") assert.fail(JSON.stringify(value.error));
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Local import did not reach " + phase);
}
async function commit(manager, view) {
    await manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash });
    return wait(manager, view.importId);
}
async function rewrite(bytes, edit) {
    const verified = await verifyDeterministicArchive(bytes, { retainStaging: true });
    try {
        const entries = await Promise.all(verified.entries.map(async (entry) => ({ name: entry.name, bytes: await fs.readFile(entry.path) })));
        edit(entries);
        return encodeDeterministicArchive(entries).bytes;
    } finally { await verified.cleanup(); }
}
function editManifest(entries, edit) {
    const manifest = JSON.parse(entries[0].bytes);
    edit(manifest);
    entries[0].bytes = Buffer.from(canonicalMarketplaceBytes(manifest));
}

test("MKT-17 uploads with Windows file-flush permissions", async (t) => {
    const { source, target, manager, manifest } = await fixture(t);
    const bytes = await archive(source, manifest);
    const open = fs.open;
    let flushes = 0;
    t.mock.method(fs, "open", async (file, flags, ...args) => {
        const handle = await open(file, flags, ...args);
        if (path.dirname(file) === path.join(manager.root, "incoming")) {
            const sync = handle.sync.bind(handle);
            t.mock.method(handle, "sync", async () => {
                flushes += 1;
                if (flags === "r") throw Object.assign(new Error("read-only fsync"), { code: "EPERM", syscall: "fsync" });
                await sync();
            });
        }
        return handle;
    });

    const view = await manager.create(Readable.from(bytes), { contentLength: bytes.length });
    assert.equal(view.phase, "awaiting-confirmation");
    assert.equal(flushes, 1);
    assert.equal(await target.getRunManifest(manifest.id), null);
    await commit(manager, view);
});

test("MKT-17 rejects a failed upload flush, cleans intake, and accepts a retry", async (t) => {
    const { source, target, manager, manifest } = await fixture(t);
    const bytes = await archive(source, manifest);
    const open = fs.open;
    const failure = Object.assign(new Error("file-flush failure"), { code: "EIO", syscall: "fsync" });
    const closes = [];
    const mockedOpen = t.mock.method(fs, "open", async (file, flags, ...args) => {
        const handle = await open(file, flags, ...args);
        if (path.dirname(file) === path.join(manager.root, "incoming")) {
            t.mock.method(handle, "sync", async () => { throw failure; });
            closes.push(t.mock.method(handle, "close"));
        }
        return handle;
    });

    await assert.rejects(manager.create(Readable.from(bytes)), (error) => error === failure);
    assert.equal(closes.length, 1);
    assert.equal(closes[0].mock.callCount(), 1);
    assert.deepEqual(await fs.readdir(path.join(manager.root, "incoming")), []);
    assert.deepEqual((await manager.list()).entries, []);
    assert.equal(await target.getRunManifest(manifest.id), null);
    mockedOpen.mock.restore();
    assert.equal((await manager.create(Readable.from(bytes))).phase, "awaiting-confirmation");
});

test("MKT-17 prepares without authoring writes, freezes bindings, and reimports intact content once", async (t) => {
    const { source, target, manager, manifest } = await fixture(t);
    const bytes = await archive(source, manifest);
    const view = await manager.create(Readable.from(bytes), { contentLength: bytes.length });
    assert.equal(view.phase, "awaiting-confirmation");
    assert.equal(view.review.committable, true);
    assert.equal(await target.getRunManifest(manifest.id), null);
    assert.equal(await target.getEnvironment("local-yard"), null);
    await target.putBindings({ kind: "cev-sim.script-bindings", version: 2, enabled: true, updatedAt: new Date().toISOString(), folders: [], bindings: [{ id: "unrelated", name: "Unrelated", scope: "global", scriptId: "missing", enabled: true }] });
    const completed = await commit(manager, view);
    const run = await target.getRunManifest(completed.destinationManifestId);
    assert.equal(run.scripts.bindingSource, "embedded");
    assert.deepEqual(run.scripts.embeddedBindings, []);
    assert.deepEqual((await target.resolveRunManifest(run.id)).bindings.entries, []);
    const repeated = await manager.create(Readable.from(bytes));
    assert.equal(repeated.phase, "complete");
    assert.equal(repeated.planHash, completed.planHash);
    assert.equal((await target.getRunManifest(run.id)).revision, run.revision);
    assert.equal(await fs.stat(path.join(manager.root, view.importId, "work")).catch(() => null), null);
});

test("MKT-17 preserves collisions and edits, rejects changed confirmations, and handles concurrent replay", async (t) => {
    const { source, target, manager, manifest } = await fixture(t);
    const bytes = await archive(source, manifest);
    await target.createRunManifest({ ...manifest, name: "Keep my original" });
    const view = await manager.create(Readable.from(bytes));
    assert.match(view.review.destinationManifestId, /^shared-local-run-mkt-/);
    await assert.rejects(manager.commit(view.importId, { expectedRevision: view.revision, planHash: "a".repeat(64) }), { code: "CONFLICT" });
    await assert.rejects(manager.commit(view.importId, { expectedRevision: view.revision + 1, planHash: view.planHash }), { code: "CONFLICT" });
    await Promise.all([manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash }), manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash })]);
    const completed = await wait(manager, view.importId);
    const imported = await target.getRunManifest(completed.destinationManifestId);
    await target.putRunManifest(imported.id, { manifest: { ...imported, name: "Edited import" }, expectedRevision: imported.revision });
    const next = await manager.create(Readable.from(bytes));
    assert.equal(next.phase, "awaiting-confirmation");
    assert.notEqual(next.review.destinationManifestId, imported.id);
    await commit(manager, next);
    assert.equal((await target.getRunManifest(imported.id)).name, "Edited import");
    assert.equal((await target.getRunManifest(manifest.id)).name, "Keep my original");
});

test("MKT-17 carries Protobuf interface bytes into a fresh destination and preserves v1", async (t) => {
    const { source, target, manager, manifest } = await fixture(t);
    const schema = await loadDescriptorFile(path.resolve("tests/fixtures/protobuf/onboarding/autonomy.binpb"));
    const iface = await source.putProtobufInterface({ kind: "cev-sim.protobuf-interface", version: 2, schemas: [{ id: "onboarding", fingerprint: schema.fingerprint, descriptorBase64: schema.descriptorBase64 }], routes: [], bootstrap: [] });
    const run = await source.putRunManifest(manifest.id, { manifest: { ...manifest, protobuf: { mode: "zenoh", interfaceHash: iface.hash, externalController: false } }, expectedRevision: manifest.revision });
    const legacy = await archive(source, run, 1);
    const blocked = await manager.create(Readable.from(legacy));
    assert.equal(blocked.review.committable, false);
    assert.match(blocked.review.blockingIssues[0], /Protobuf interface/);
    await assert.rejects(manager.commit(blocked.importId, { expectedRevision: blocked.revision, planHash: blocked.planHash }), { code: "RIGHTS_DENIED" });
    await manager.cancel(blocked.importId, blocked.revision);
    const bytes = await archive(source, run);
    assert.deepEqual(bytes, await archive(source, run));
    const verified = await verifyRunTemplatePackage(bytes);
    assert.equal(verified.manifest.version, 2);
    assert.equal(verified.protobufInterface.hash, iface.hash);
    await verified.cleanup();
    const view = await manager.create(Readable.from(bytes));
    assert.equal(await target.getProtobufInterface(iface.hash), null);
    const completed = await commit(manager, view);
    assert.deepEqual(await target.getProtobufInterface(iface.hash), iface.document);
    assert.equal((await target.resolveRunManifest(completed.destinationManifestId)).protobufInterface.hash, iface.hash);
    await fs.rm(target._protobufInterfaces._path(iface.hash));
    const repair = await manager.create(Readable.from(bytes));
    assert.equal(repair.phase, "awaiting-confirmation");
    await commit(manager, repair);
    assert.deepEqual(await target.getProtobufInterface(iface.hash), iface.document);
    const existing = await manager.create(Readable.from(legacy));
    assert.equal(existing.review.committable, true);
    const mismatch = await rewrite(bytes, (entries) => editManifest(entries, (value) => { value.protobufInterface.interfaceHash = "0".repeat(64); }));
    await assert.rejects(manager.create(Readable.from(mismatch)), /Protobuf interface/);
});

test("MKT-17 imports unsigned plugin bytes as manual owners without executing them or removing registry owners", async (t) => {
    const { source, target, manager, manifest } = await fixture(t);
    const plugin = await pluginFixtureResource({ mutateFiles: (files) => { files["runtime/index.js"] = new TextEncoder().encode("throw new Error('IMPORT EXECUTED'); export function register() {}"); } });
    await source.plugins.putPackage(plugin);
    await source.plugins.addManualOwner(plugin.packageHash);
    const run = await source.putRunManifest(manifest.id, { manifest: { ...manifest, plugins: { enabled: true, artifacts: [{ pluginId: "acme.example", expectedHash: plugin.packageHash, capabilities: [] }] } }, expectedRevision: manifest.revision });
    await assert.rejects(archive(source, run, 1), /requires one exact marketplace release/);
    const bytes = await archive(source, run);
    const verified = await verifyRunTemplatePackage(bytes);
    assert.equal(Object.hasOwn(verified.manifest.plugins[0], "release"), false);
    await verified.cleanup();
    const owner = { sourceId: "11111111-1111-4111-8111-111111111111", itemId: "acme.example", releaseVersion: "1.0.0", artifactSha256: "b".repeat(64) };
    await target.plugins.addMarketplaceOwner(plugin, owner);
    const other = await pluginFixtureResource({ fixture: "acme.example-v2" });
    await target.plugins.putPackage(other); await target.plugins.addManualOwner(other.packageHash);
    const view = await manager.create(Readable.from(bytes));
    assert.equal((await target.plugins.snapshotWithOwners()).packages.find((entry) => entry.packageHash === plugin.packageHash).ownership.manual, false);
    await commit(manager, view);
    const library = await target.plugins.snapshotWithOwners();
    const imported = library.packages.find((entry) => entry.packageHash === plugin.packageHash);
    assert.deepEqual(imported.ownership, { manual: true, marketplace: [owner] });
    assert.ok(library.packages.find((entry) => entry.packageHash === other.packageHash));
    await target.plugins.removeManualOwner("acme.example", plugin.packageHash);
    const repeated = await manager.create(Readable.from(bytes));
    assert.equal(repeated.phase, "awaiting-confirmation");
    assert.equal(repeated.review.mappings.find((entry) => entry.resourceKind === "run-template-plugin-package").action, "reuse");
    await commit(manager, repeated);
    assert.equal((await target.plugins.snapshotWithOwners()).packages.find((entry) => entry.packageHash === plugin.packageHash).ownership.manual, true);
    const malformed = await rewrite(bytes, (entries) => editManifest(entries, (value) => { value.plugins[0].release = null; }));
    await assert.rejects(manager.create(Readable.from(malformed)), /release/);
    const released = await archive(source, run, 1, [{ packageHash: plugin.packageHash, itemId: "acme.example", releaseVersion: "1.0.0", artifactSha256: "b".repeat(64) }]);
    assert.deepEqual(released, await archive(source, run, 1, [{ packageHash: plugin.packageHash, itemId: "acme.example", releaseVersion: "1.0.0", artifactSha256: "b".repeat(64) }]));
});

test("MKT-17 resumes publication without a completion marker and verifies completed content before continuing", async (t) => {
    let failPublication = true;
    const f = await fixture(t, { fault: (point, { index }) => { if (point === "after-operation-publication" && index === 0 && failPublication) throw new Error("crash"); } });
    const view = await f.manager.create(Readable.from(await archive(f.source, f.manifest)));
    await f.manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash });
    const stopped = await wait(f.manager, view.importId, "needs-attention");
    assert.equal(stopped.completions.length, 0);
    assert.ok(await f.target.getEnvironment("local-yard"));
    assert.equal(await f.target.getRunManifest(f.manifest.id), null);
    failPublication = false;
    await f.manager.resume(view.importId, stopped.revision);
    await wait(f.manager, view.importId);

    let stopAfterMarker = true;
    const g = await fixture(t, { fault: (point, { index }) => { if (point === "after-operation-completion" && index === 0 && stopAfterMarker) throw new Error("crash"); } });
    const prepared = await g.manager.create(Readable.from(await archive(g.source, g.manifest)));
    await g.manager.commit(prepared.importId, { expectedRevision: prepared.revision, planHash: prepared.planHash });
    const partial = await wait(g.manager, prepared.importId, "needs-attention");
    assert.equal(partial.completions.length, 1);
    const environment = await g.target.getEnvironment("local-yard");
    await g.target.putEnvironment("local-yard", { manifest: { ...environment, name: "Keep edited environment" }, expectedRevision: environment.revision, supportedRoadGeometryVersions: [1, 2], supportedAssetMetricVersions: [1], supportedEditorSourceVersions: [1] });
    stopAfterMarker = false;
    await g.manager.resume(partial.importId, partial.revision);
    const conflict = await wait(g.manager, partial.importId, "needs-attention");
    assert.equal(conflict.error.code, "CONFLICT");
    assert.equal(await g.target.getRunManifest(g.manifest.id), null);
    const replanned = await g.manager.replan(conflict.importId, conflict.revision);
    assert.notEqual(replanned.planHash, prepared.planHash);
    await commit(g.manager, replanned);
    assert.equal((await g.target.getEnvironment("local-yard")).name, "Keep edited environment");
});

test("MKT-17 replays vehicle intake and recovers confirmed work on startup", async (t) => {
    const f = await fixture(t);
    const vehicle = await f.source.createVehicleManifest(createDefaultVehicleManifest({ id: "local-rover" }));
    await f.source.putVehicleAsset(vehicle.id, "extra.bin", Buffer.from("model bytes"));
    const run = await f.source.putRunManifest(f.manifest.id, { manifest: { ...f.manifest, initialState: { ...f.manifest.initialState, vehicles: f.manifest.initialState.vehicles.map((entry) => ({ ...entry, type: vehicle.id })) } }, expectedRevision: f.manifest.revision });
    const view = await f.manager.create(Readable.from(await archive(f.source, run)));
    await f.manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash });
    await f.manager.close();
    const replacement = new LocalRunTemplateImportManager(f.target.dataDir, { storageService: f.target, pluginStore: f.target.plugins, editorAssetStore: f.target.editorAssets, visualAssetStore: f.target.visualAssets });
    t.after(() => replacement.close());
    await replacement.recover();
    const complete = await replacement.get(view.importId);
    assert.equal(complete.phase, "complete");
    assert.deepEqual(await f.target.readVehicleAsset(vehicle.id, "extra.bin"), Buffer.from("model bytes"));
});

test("MKT-17 checks destination rights during review, confirmation, and partial-import resume", async (t) => {
    let crash = true;
    const f = await fixture(t, { fault: async (point, { index }) => {
        if (point === "after-operation-publication" && index === 0 && crash) throw new Error("crash");
    } });
    await writeRegistry(f.source.dataDir, [ownedGrant()]);
    const asset = await publishAsset(f.source.visualAssets, makeTriangleGlb(), { mediaType: "model/gltf-binary", role: "mesh" });
    await f.source.editorAssets.publishRevision({ assetId: "local-crate", name: "Crate", publicationId: "local-crate", modelUseHash: asset.useHash }, 0);
    const environment = await f.source.getEnvironment("local-yard");
    await f.source.putEnvironment("local-yard", {
        manifest: { ...environment, document: { ...environment.document, objects: [...environment.document.objects, {
            id: "crate", typeId: "asset-instance", typeVersion: 1, name: "Crate", parentId: null, order: environment.document.objects.length,
            components: { tags: [], locked: false, editorHidden: false, asset: { assetId: "local-crate", revision: 1, position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, overrides: {} } },
        }] } }, expectedRevision: environment.revision, supportedRoadGeometryVersions: [1, 2], supportedAssetMetricVersions: [1], supportedEditorSourceVersions: [1],
    });
    const bytes = await archive(f.source, f.manifest);
    const deny = () => writeRegistry(f.target.dataDir, [restrictedGrant("owned-lab")]);
    const allow = () => writeRegistry(f.target.dataDir, [ownedGrant()]);
    await deny();
    const blocked = await f.manager.create(Readable.from(bytes));
    assert.equal(blocked.review.committable, false);
    assert.ok(blocked.review.rights.some((right) => !right.allowed));
    await f.manager.cancel(blocked.importId, blocked.revision);
    await allow();
    const view = await f.manager.create(Readable.from(bytes));
    await deny();
    await assert.rejects(f.manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash }), { code: "RIGHTS_DENIED" });
    assert.equal(await f.target.getEnvironment("local-yard"), null);
    await allow();
    await f.manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash });
    const partial = await wait(f.manager, view.importId, "needs-attention");
    crash = false;
    await deny();
    await f.manager.resume(view.importId, partial.revision);
    const denied = await wait(f.manager, view.importId, "needs-attention");
    assert.equal(denied.error.code, "RIGHTS_DENIED");
    assert.equal(await f.target.getRunManifest(f.manifest.id), null);
    await allow();
    await f.manager.resume(view.importId, denied.revision);
    await wait(f.manager, view.importId);
});

test("MKT-17 rejects changed plan and preparation bytes and cleans terminal work after restart", async (t) => {
    const f = await fixture(t);
    const bytes = await archive(f.source, f.manifest);
    const view = await f.manager.create(Readable.from(bytes));
    const planPath = path.join(f.manager.root, view.importId, "plans", view.planHash + ".json");
    const planBytes = await fs.readFile(planPath);
    await fs.writeFile(planPath, Buffer.concat([planBytes, Buffer.from(" ")]));
    await assert.rejects(f.manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash }), { code: "RECOVERY_REQUIRED" });
    assert.equal(await f.target.getEnvironment("local-yard"), null);
    await fs.writeFile(planPath, planBytes);
    const plan = JSON.parse(planBytes);
    const workDirectory = path.join(f.manager.root, view.importId, "work");
    const preparation = await readRunTemplatePackagePreparation({ workDirectory, preparationHash: plan.preparationHash, archiveSha256: view.importId });
    await fs.appendFile(preparation.entries[0].path, "tamper");
    await f.manager.commit(view.importId, { expectedRevision: view.revision, planHash: view.planHash });
    await wait(f.manager, view.importId, "needs-attention");
    assert.equal(await f.target.getEnvironment("local-yard"), null);

    const g = await fixture(t, { fault: (point) => { if (point === "after-import-complete") throw new Error("crash before cleanup"); } });
    const completed = await commit(g.manager, await g.manager.create(Readable.from(await archive(g.source, g.manifest))));
    await g.manager.close();
    const replacement = new LocalRunTemplateImportManager(g.target.dataDir, { storageService: g.target, pluginStore: g.target.plugins, editorAssetStore: g.target.editorAssets, visualAssetStore: g.target.visualAssets });
    t.after(() => replacement.close());
    await replacement.recover();
    assert.equal((await replacement.get(completed.importId)).phase, "complete");
    assert.equal(await fs.stat(path.join(replacement.root, completed.importId, "work")).catch(() => null), null);
});

test("MKT-17 rejects hostile, incomplete, over-budget, and substituted packages and cleans staging", async (t) => {
    const { source, manager, manifest } = await fixture(t);
    const bytes = await archive(source, manifest);
    for (const name of ["../escape", "/absolute", "a\\b"]) await assert.rejects(manager.create(Readable.from(Buffer.concat([encodeUstarFile(name, Buffer.from("bad")), ustarEof()]))));
    for (const typeflag of ["1", "2", "x", "g"]) await assert.rejects(manager.create(Readable.from(Buffer.concat([encodeUstarFile("manifest.json", Buffer.from("{}"), { typeflag }), ustarEof()]))));
    await assert.rejects(manager.create(Readable.from(bytes.subarray(0, bytes.length - 100))), /EOF|USTAR|Archive|archive|ended/);
    await assert.rejects(manager.create(Readable.from(bytes), { contentLength: bytes.length + 1 }), { code: "DOCUMENT_INVALID" });
    const changed = await rewrite(bytes, (entries) => { entries[1].bytes = Buffer.from("{}"); });
    await assert.rejects(manager.create(Readable.from(changed)));
    const missing = await rewrite(bytes, (entries) => { entries.splice(1, 1); });
    await assert.rejects(manager.create(Readable.from(missing)), /entries|manifest/);
    const other = await rewrite(bytes, (entries) => editManifest(entries, (value) => { value.kind = "cev-sim.environment-package"; }));
    await assert.rejects(manager.create(Readable.from(other)), /Expected/);
    const dir = path.join(manager.root, "incoming");
    assert.deepEqual(await fs.readdir(dir), []);
    const limited = new LocalRunTemplateImportManager(source.dataDir, { storageService: source, pluginStore: source.plugins, editorAssetStore: source.editorAssets, visualAssetStore: source.visualAssets, limits: { archiveBytes: 1024 } });
    t.after(() => limited.close());
    await assert.rejects(limited.create(Readable.from([Buffer.alloc(600), Buffer.alloc(600)])), { code: "LIMIT_EXCEEDED" });
    await assert.rejects(limited.create(Readable.from(bytes), { contentLength: bytes.length }), { code: "LIMIT_EXCEEDED" });
});

test("MKT-17 HTTP import requires no sources, exposes review/progress, and leaves registry ledgers empty", async (t) => {
    const f = await fixture(t);
    const service = await MarketplaceService.open(f.target.dataDir, { storageService: f.target, pluginStore: f.target.plugins, editorAssetStore: f.target.editorAssets, visualAssetStore: f.target.visualAssets, fetchImpl: () => { throw new Error("Registry contacted"); } });
    t.after(() => service.close());
    const app = express(); app.use("/api/marketplace", createMarketplaceRouter(service, { logger: { error() {} } }));
    const server = await new Promise((resolve, reject) => { const listener = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve(listener)); listener.once("error", reject); });
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    const origin = "http://127.0.0.1:" + server.address().port;
    const bytes = await archive(f.source, f.manifest);
    const response = await fetch(origin + "/api/marketplace/local-imports", { method: "POST", body: bytes, headers: { "content-type": "application/vnd.cev-sim.run-template-package+tar" } });
    assert.equal(response.status, 201, await response.clone().text());
    const view = await response.json();
    assert.equal(response.headers.get("cache-control"), "no-store");
    const confirms = await fetch(origin + "/api/marketplace/local-imports/" + view.importId + "/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: view.revision, planHash: view.planHash }) });
    assert.equal(confirms.status, 202, await confirms.text());
    await wait(service.localImportManager, view.importId);
    assert.deepEqual((await service.sourceStore.snapshot()).sources, []);
    assert.deepEqual((await service.installedStore.snapshot()).installations, []);
    assert.deepEqual(await fs.readdir(service.receiptStore.paths.receipts), []);
    assert.equal((await service.listLocalRunTemplateImports()).entries.length, 1);
    const badMedia = await fetch(origin + "/api/marketplace/local-imports", { method: "POST", body: bytes, headers: { "content-type": "application/vnd.cev-sim.run-package+tar" } });
    assert.equal(badMedia.status, 422);
    const hostile = await fetch(origin + "/api/marketplace/local-imports", { method: "POST", body: Buffer.concat([encodeUstarFile("../escape", Buffer.from("bad")), ustarEof()]), headers: { "content-type": "application/vnd.cev-sim.run-template-package+tar" } });
    assert.equal(hostile.status, 422);
    assert.equal((await hostile.json()).error.code, "DOCUMENT_INVALID");
    const file = path.join(f.directory, "v2.tar"); await fs.writeFile(file, bytes);
    await assert.rejects(artifactAdapterRegistry.inspect("run-template", { path: file, mediaType: "application/vnd.cev-sim.run-template-package+tar", sha256: view.importId, sizeBytes: bytes.length }), { code: "UNSUPPORTED_SCHEMA" });
});
