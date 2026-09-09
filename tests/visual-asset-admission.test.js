import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import { HEADLESS_PROTOCOL, ERROR_CODE } from "../server/headless/HeadlessProtocol.js";
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { stageRunPackage } from "../server/headless/VisualAssetAdmission.js";
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
    const abandoned = path.join(supervisor.config.assetAdmission.inboxDir, ".abandoned.processing-test");
    await fs.writeFile(abandoned, "partial");
    await supervisor.close();

    const restarted = new HeadlessSupervisor({ socket: path.join(root, "supervisor.sock") });
    t.after(() => restarted.close());
    await restarted.admissionManager.initialize();
    assert.equal(restarted.admissionManager.records.get(admitted.admission.handle)?.batchPins, 0);
    await assert.rejects(() => fs.access(abandoned));
    const released = await restarted.releaseAssetAdmission({ handle: admitted.admission.handle });
    assert.equal(released.error.code, ERROR_CODE.OK);
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
