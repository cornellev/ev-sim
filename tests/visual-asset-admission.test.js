import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

import { normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import { HEADLESS_PROTOCOL, ERROR_CODE } from "../server/headless/HeadlessProtocol.js";
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { stageRunPackage, VisualAssetAdmissionManager } from "../server/headless/VisualAssetAdmission.js";
import { encodeRunPackage } from "../server/headless/VisualAssetPack.js";
import { createPortableHeadlessBundle } from "./helpers/headlessRunnerBundle.js";

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-admission-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bundle = await createPortableHeadlessBundle();
    const exactBundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
    const encoded = encodeRunPackage({ bundleBytes: exactBundleBytes });
    const packagePath = path.join(root, "run.run-package");
    await fs.writeFile(packagePath, encoded.bytes);
    const supervisor = new HeadlessSupervisor({
        socket: path.join(root, "supervisor.sock"),
        inlineObservations: true,
    });
    t.after(() => supervisor.close());
    return { root, bundle, encoded, packagePath, supervisor };
}

test("VIS-13b admission binds exact archived bytes to canonical wire JSON and batch lifetime", async (t) => {
    const { root, bundle, encoded, packagePath, supervisor } = await fixture(t);
    const capabilities = await supervisor.getCapabilities({ clientProtocol: HEADLESS_PROTOCOL });
    assert.deepEqual(capabilities.assetAdmissionProfiles, ["cev-sim.run-package@1"]);
    const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir);
    const admitted = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: staged.stagingId,
        archiveHash: staged.archiveHash,
    });
    assert.equal(admitted.error.code, ERROR_CODE.OK, admitted.error.message);
    assert.equal(admitted.admission.bundleBytesHash, encoded.bundleBytesHash);
    await assert.rejects(() => fs.access(staged.path));

    const episode = normalizeEpisodeSpec(bundle.resolved, {});
    const envelope = {
        bundleId: episode.runBundleId,
        resolvedHash: bundle.resolvedHash,
        simulationSemanticHash: bundle.simulationSemanticHash,
        canonicalJson: Buffer.from(canonicalRunBundleStringify(bundle)),
        assetAdmission: admitted.admission,
    };
    const mismatch = await supervisor.createBatch({
        clientProtocol: HEADLESS_PROTOCOL,
        runBundles: [{ ...envelope, assetAdmission: { ...admitted.admission, bundleBytesHash: "0".repeat(64) } }],
        episodes: [episode],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "mismatch") },
    });
    assert.equal(mismatch.error.code, ERROR_CODE.BUNDLE_INVALID);
    assert.equal(supervisor.activeEnvironmentCount, 0);

    const failedAfterPin = await supervisor.createBatch({
        clientProtocol: HEADLESS_PROTOCOL,
        runBundles: [envelope],
        episodes: [episode],
        artifactPolicy: { profile: 3, outputUri: "" },
    });
    assert.equal(failedAfterPin.error.code, ERROR_CODE.INVALID_REQUEST);
    assert.equal(supervisor.admissionManager.records.get(admitted.admission.handle)?.batchPins, 0);

    const created = await supervisor.createBatch({
        clientProtocol: HEADLESS_PROTOCOL,
        runBundles: [envelope],
        episodes: [episode],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "artifacts") },
    });
    assert.equal(created.error.code, ERROR_CODE.OK, created.error.message);
    const reset = await supervisor.resetBatch({ batchId: created.batch.batchId, episodes: [episode] });
    assert.equal(reset.error.code, ERROR_CODE.OK);
    assert.equal(reset.results[0].error.code, ERROR_CODE.OK);
    assert.equal(supervisor.admissionManager.records.get(admitted.admission.handle)?.batchPins, 1);
    const environment = supervisor.batches.get(created.batch.batchId).environments[0];
    await supervisor._recover(environment, new Error("synthetic admitted-worker crash"));
    assert.equal(environment.state, "prepared");
    assert.equal(supervisor.admissionManager.records.get(admitted.admission.handle)?.batchPins, 1);
    await supervisor.releaseAssetAdmission({ handle: admitted.admission.handle });
    assert.equal(supervisor.admissionManager.records.get(admitted.admission.handle)?.batchPins, 1);
    await supervisor.admissionManager.revalidate(admitted.admission.handle);
    const scopedReader = supervisor.admissionManager.createDigestReader(admitted.admission.handle, "test-environment");
    await assert.rejects(() => scopedReader.open("0".repeat(64)), /outside the admitted closure/);
    const record = supervisor.admissionManager.records.get(admitted.admission.handle);
    assert.ok(record);
    record.digestUses["0".repeat(64)] = "1".repeat(64);
    await assert.rejects(() => supervisor.admissionManager.revalidate(admitted.admission.handle), /identity changed/);
    delete record.digestUses["0".repeat(64)];
    scopedReader.close();
    await assert.rejects(() => scopedReader.open("0".repeat(64)), /not pinned/);
    const closed = await supervisor.closeBatch({ batchId: created.batch.batchId, finalizeActiveEpisodes: false });
    assert.equal(closed.error.code, ERROR_CODE.OK);
    assert.equal(supervisor.admissionManager.records.has(admitted.admission.handle), false);
});

test("VIS-13b legacy exact package bytes bind to legacy canonical wire JSON", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-admission-legacy-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const exactBundleBytes = await fs.readFile(new URL("fixtures/visual-layer/legacy-state.v10.json", import.meta.url));
    const bundle = JSON.parse(exactBundleBytes);
    const encoded = encodeRunPackage({ bundleBytes: exactBundleBytes });
    const packagePath = path.join(root, "legacy.run-package");
    await fs.writeFile(packagePath, encoded.bytes);
    const supervisor = new HeadlessSupervisor({ socket: path.join(root, "supervisor.sock") });
    t.after(() => supervisor.close());
    const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir);
    const admitted = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: staged.stagingId,
        archiveHash: staged.archiveHash,
    });
    assert.equal(admitted.error.code, ERROR_CODE.OK, admitted.error.message);
    const binding = await supervisor.admissionManager.bind({
        ...admitted.admission,
        canonicalBytes: Buffer.from(canonicalRunBundleStringify(bundle)),
    });
    assert.deepEqual(binding.exactBytes, exactBundleBytes);
    await supervisor.releaseAssetAdmission({ handle: admitted.admission.handle });
});

test("VIS-13b rejects hostile inbox entries and removes every claimed staging name", async (t) => {
    const { encoded, packagePath, supervisor } = await fixture(t);
    const invalidId = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: "../escape",
        archiveHash: encoded.archiveHash,
    });
    assert.equal(invalidId.error.code, ERROR_CODE.INVALID_REQUEST);

    const symlinkId = "1".repeat(32);
    const symlinkPath = path.join(supervisor.config.assetAdmission.inboxDir, `${symlinkId}.run-package`);
    await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
    await fs.symlink(packagePath, symlinkPath);
    const symlink = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: symlinkId,
        archiveHash: encoded.archiveHash,
    });
    assert.equal(symlink.error.code, ERROR_CODE.INVALID_REQUEST);
    await assert.rejects(() => fs.lstat(symlinkPath));
    assert.equal((await fs.stat(packagePath)).isFile(), true);

    const hardlinkId = "2".repeat(32);
    const hardlinkPath = path.join(supervisor.config.assetAdmission.inboxDir, `${hardlinkId}.run-package`);
    await fs.link(packagePath, hardlinkPath);
    const hardlink = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: hardlinkId,
        archiveHash: encoded.archiveHash,
    });
    assert.equal(hardlink.error.code, ERROR_CODE.INVALID_REQUEST);
    await assert.rejects(() => fs.lstat(hardlinkPath));
    assert.equal((await fs.stat(packagePath)).nlink, 1);

    const directoryId = "3".repeat(32);
    const directoryPath = path.join(supervisor.config.assetAdmission.inboxDir, `${directoryId}.run-package`);
    await fs.mkdir(path.join(directoryPath, "nested"), { recursive: true });
    const directory = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: directoryId,
        archiveHash: encoded.archiveHash,
    });
    assert.equal(directory.error.code, ERROR_CODE.BUNDLE_INVALID);
    await assert.rejects(() => fs.lstat(directoryPath));

    const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir);
    const wrongHash = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: staged.stagingId,
        archiveHash: "0".repeat(64),
    });
    assert.equal(wrongHash.error.code, ERROR_CODE.BUNDLE_INVALID);
    await assert.rejects(() => fs.lstat(staged.path));
    assert.equal((await fs.readdir(supervisor.config.assetAdmission.inboxDir)).length, 0);
});

test("VIS-13b startup preserves valid admissions while clearing stale pins and abandoned inbox claims", async (t) => {
    const { root, encoded, packagePath, supervisor } = await fixture(t);
    const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir);
    const admitted = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: staged.stagingId,
        archiveHash: staged.archiveHash,
    });
    assert.equal(admitted.error.code, ERROR_CODE.OK, admitted.error.message);
    const record = supervisor.admissionManager.records.get(admitted.admission.handle);
    assert.ok(record);
    record.batchPins = 1;
    await supervisor.admissionManager._persist(record);
    const abandoned = path.join(supervisor.config.assetAdmission.inboxDir, `.${"a".repeat(32)}.processing-${"a".repeat(36)}`);
    await fs.writeFile(abandoned, "partial");
    const unrelated = path.join(supervisor.config.assetAdmission.inboxDir, "user-notes.txt");
    await fs.writeFile(unrelated, "must survive recovery");
    await fs.utimes(unrelated, new Date(0), new Date(0));
    await supervisor.close();

    const restarted = new HeadlessSupervisor({ socket: path.join(root, "supervisor.sock") });
    t.after(() => restarted.close());
    await restarted.admissionManager.initialize();
    assert.equal(restarted.admissionManager.records.get(admitted.admission.handle)?.batchPins, 0);
    await assert.rejects(() => fs.access(abandoned));
    assert.equal(await fs.readFile(unrelated, "utf8"), "must survive recovery");
    const released = await restarted.releaseAssetAdmission({ handle: admitted.admission.handle });
    assert.equal(released.error.code, ERROR_CODE.OK);
});

async function admittedFixture(t) {
    const result = await fixture(t);
    const { root, packagePath, bundle, supervisor } = result;
    const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir);
    const admission = await supervisor.admissionManager.admit(staged);
    const episode = normalizeEpisodeSpec(bundle.resolved, {});
    const request = {
        clientProtocol: HEADLESS_PROTOCOL,
        runBundles: [{
            bundleId: episode.runBundleId, resolvedHash: bundle.resolvedHash,
            simulationSemanticHash: bundle.simulationSemanticHash,
            canonicalJson: Buffer.from(canonicalRunBundleStringify(bundle)), assetAdmission: admission,
        }],
        episodes: [episode], artifactPolicy: { profile: 3, outputUri: path.join(root, "artifacts") },
    };
    return { ...result, admission, request };
}

test("VIS-13b concurrent closes release exactly one pin and preserve another live batch", async (t) => {
    const { supervisor, admission, request } = await admittedFixture(t);
    const first = await supervisor.createBatch(request);
    const second = await supervisor.createBatch(request);
    assert.equal(first.error.code, ERROR_CODE.OK, first.error.message);
    assert.equal(second.error.code, ERROR_CODE.OK, second.error.message);
    await supervisor.admissionManager.release(admission.handle);
    const close = { batchId: first.batch.batchId, finalizeActiveEpisodes: true };
    const results = await Promise.all([supervisor.closeBatch(close), supervisor.closeBatch(close)]);
    assert.ok(results.every((response) => response.error.code === ERROR_CODE.OK));
    assert.equal(supervisor.admissionManager.records.get(admission.handle).batchPins, 1);
    await supervisor.admissionManager.revalidate(admission.handle);
    await supervisor.closeBatch({ batchId: second.batch.batchId });
    assert.equal(supervisor.admissionManager.records.has(admission.handle), false);
});

test("VIS-13b worker reservations cover asynchronous pin acquisition", async (t) => {
    const { supervisor, request } = await admittedFixture(t);
    supervisor.config = { ...supervisor.config, maxWorkers: 1 };
    let entered;
    let unblock;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { unblock = resolve; });
    const acquire = supervisor.admissionManager.acquireBatch.bind(supervisor.admissionManager);
    supervisor.admissionManager.acquireBatch = async (handles) => { entered(); await gate; return acquire(handles); };
    const first = supervisor.createBatch(request);
    await started;
    let second;
    try { second = await supervisor.createBatch(request); }
    finally { unblock(); }
    assert.equal(second.error.code, ERROR_CODE.RESOURCE_LIMIT);
    const created = await first;
    assert.equal(created.error.code, ERROR_CODE.OK, created.error.message);
    await supervisor.closeBatch({ batchId: created.batch.batchId });
});

test("VIS-13b failed pin persistence leaves no phantom batch pin", async (t) => {
    const { supervisor, admission } = await admittedFixture(t);
    const manager = supervisor.admissionManager;
    manager.faults.persistAdmission = () => { throw new Error("pin persistence failed"); };
    await assert.rejects(() => manager.acquireBatch([admission.handle]), /pin persistence failed/);
    assert.equal(manager.records.get(admission.handle).batchPins, 0);
    delete manager.faults.persistAdmission;
    await manager.release(admission.handle);
    assert.equal(manager.records.has(admission.handle), false);
});

test("VIS-13b shutdown waits for failed in-flight creation before closing the admission store", async (t) => {
    const { supervisor, admission, request } = await admittedFixture(t);
    const manager = supervisor.admissionManager;
    const revalidate = manager.revalidate.bind(manager);
    let entered;
    let unblock;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { unblock = resolve; });
    manager.revalidate = async (handle) => { entered(); await gate; return revalidate(handle); };
    const creation = supervisor.createBatch(request);
    await started;
    await manager.release(admission.handle);
    const closing = supervisor.close();
    unblock();
    const created = await creation;
    assert.notEqual(created.error.code, ERROR_CODE.OK);
    await closing;
    assert.equal(supervisor.activeEnvironmentCount, 0);
    assert.equal(manager.records.has(admission.handle), false);
    assert.equal(manager._activeScopes.size, 0);
});

test("VIS-13b admission storage rejects overlapping owners and recovers a dead owner", async (t) => {
    const { supervisor, admission } = await admittedFixture(t);
    const manager = supervisor.admissionManager;
    const competing = new VisualAssetAdmissionManager(supervisor.config.assetAdmission);
    t.after(() => competing.close());
    await assert.rejects(() => competing.initialize(), /live supervisor owner/);
    assert.equal(manager.records.has(admission.handle), true);
    const ownerPath = manager.ownerPath;
    await supervisor.close();
    await fs.writeFile(ownerPath, JSON.stringify({ pid: 2147483647, token: "dead-owner" }));
    const restarted = new VisualAssetAdmissionManager(supervisor.config.assetAdmission);
    t.after(() => restarted.close());
    await restarted.initialize();
    assert.equal(restarted.records.has(admission.handle), true);
    await restarted.release(admission.handle);
});

test("VIS-13b scoped readers hide filesystem streams and drain pending opens on close", async (t) => {
    const { supervisor, admission } = await admittedFixture(t);
    const manager = supervisor.admissionManager;
    await manager.acquireBatch([admission.handle]);
    const digest = "1".repeat(64);
    manager.records.get(admission.handle).digestUses[digest] = "2".repeat(64);
    const reader = manager.createDigestReader(admission.handle, "fake-renderer");
    await assert.rejects(() => reader.open("__proto__"), /outside the admitted closure/);
    let unblock;
    let releaseCount = 0;
    let gate = Promise.resolve();
    manager.store.openUseContent = async () => {
        await gate;
        const stream = Readable.from([Buffer.from("abc")]);
        stream.path = "/private/cas/path";
        stream.fd = 123;
        return { stream, digest, size: 3, start: 0, end: 2, mediaType: "application/octet-stream",
            release: async () => { releaseCount += 1; stream.destroy(); } };
    };
    const opened = await reader.open(digest);
    assert.equal(opened.stream.fd, undefined);
    assert.equal(opened.stream.path, undefined);
    gate = new Promise((resolve) => { unblock = resolve; });
    const pending = reader.open(digest);
    const rejected = assert.rejects(pending, /not pinned/);
    const closing = reader.close();
    unblock();
    await closing;
    await rejected;
    assert.equal(opened.stream.destroyed, true);
    assert.equal(releaseCount, 2);
    await manager.release(admission.handle);
    await manager.releaseBatch([admission.handle]);
});

test("VIS-13b TCP supervisors neither advertise nor accept package admission", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-admission-tcp-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const supervisor = new HeadlessSupervisor({ tcp: "127.0.0.1:1" });
    t.after(() => supervisor.close());
    const capabilities = await supervisor.getCapabilities({ clientProtocol: HEADLESS_PROTOCOL });
    assert.deepEqual(capabilities.assetAdmissionProfiles, []);
    const response = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: "0".repeat(32),
        archiveHash: "0".repeat(64),
    });
    assert.equal(response.error.code, ERROR_CODE.UNSUPPORTED_CAPABILITY);
});
