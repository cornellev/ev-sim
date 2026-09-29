import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { marketplaceDocumentBytes } from "../server/marketplace/MarketplaceContracts.js";
import { MarketplaceRegistryReader } from "../server/marketplace/registry/RegistryReader.js";
import { MarketplaceRegistryService } from "../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";
import { generatePrivateKey, loadPrivateKey, tufKeyId } from "../server/marketplace/registry/TufKeys.js";
import { TUF_DELEGATED_ROLES } from "../server/marketplace/registry/TufMetadata.js";
import { blobPath, registryPaths, resolveRegistryPath } from "../server/marketplace/registry/RegistryLayout.js";
import { marketplacePluginDocuments } from "./helpers/marketplacePluginDocuments.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const documents = JSON.parse(await fs.readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));

async function initializedRegistry(t, prefix = "cev-mkt-tuf-") {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    const offlineRootKey = path.join(parent, "offline-root.pem");
    const registry = await MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: offlineRootKey, unsafeUnsignedDevelopment: true });
    return { parent, root, offlineRootKey, registry };
}

function item(overrides = {}) {
    return { ...structuredClone(documents.item), previews: [], ...overrides };
}

function release(artifact, overrides = {}) {
    return { ...structuredClone(documents.release), artifact, ...overrides };
}

test("MKT-04 bootstraps external Ed25519 custody and an interoperable empty TUF hierarchy", async (t) => {
    const { parent, root, offlineRootKey, registry } = await initializedRegistry(t);
    assert.equal((await fs.stat(offlineRootKey)).mode & 0o777, 0o600);
    const rootKey = await loadPrivateKey(offlineRootKey);
    assert.equal(tufKeyId(rootKey), tufKeyId(await loadPrivateKey(offlineRootKey)));

    const paths = registryPaths(root);
    assert.deepEqual((await fs.readdir(paths.tufOnlineKeys)).sort(), [
        "advisories.pem", "catalog.pem", "items.pem", "publishers.pem", "releases.pem", "snapshot.pem", "timestamp.pem",
    ]);
    for (const name of await fs.readdir(paths.tufOnlineKeys)) {
        assert.equal((await fs.stat(path.join(paths.tufOnlineKeys, name))).mode & 0o777, 0o600);
    }
    const reader = await MarketplaceRegistryReader.open(root);
    const verification = await reader.verify();
    const state = await reader.readPublishedState();
    assert.deepEqual(verification, {
        ok: true,
        rootVersion: 1,
        timestampVersion: 1,
        snapshotVersion: 1,
        roleVersions: { targets: 1, catalog: 1, items: 1, publishers: 1, releases: 1, advisories: 1 },
        catalogRevision: 1,
        catalogSha256: state.roles.catalog.metadata.signed.targets["catalog/catalog.json"].hashes.sha256,
    });
    assert.equal(state.root.metadata.signed.consistentSnapshot, true);
    assert.deepEqual(Object.keys(state.roles.advisories.metadata.signed.targets), []);
    assert.deepEqual(
        state.roles.targets.metadata.toJSON().signed.delegations.roles.map((role) => role.name),
        TUF_DELEGATED_ROLES,
    );
    assert.equal(state.root.metadata.signed.unrecognizedFields["x-cev-sim"].registryId, registry.registryId);

    await MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: offlineRootKey, registryId: registry.registryId });
    const wrongKey = path.join(parent, "wrong-root.pem");
    await fs.writeFile(wrongKey, generatePrivateKey(), { mode: 0o600 });
    await assert.rejects(
        MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: wrongKey }),
        (error) => error.code === "CONFLICT",
    );
    await assert.rejects(
        MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: path.join(root, "forbidden.pem") }),
        (error) => error.code === "CONFIG_INVALID",
    );

    const permissiveParent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-key-mode-"));
    t.after(() => fs.rm(permissiveParent, { recursive: true, force: true }));
    const permissive = path.join(permissiveParent, "root.pem");
    await fs.writeFile(permissive, generatePrivateKey(), { mode: 0o644 });
    await assert.rejects(loadPrivateKey(permissive), (error) => error.code === "CONFIG_INVALID");
    const symlink = path.join(permissiveParent, "root-link.pem");
    await fs.symlink(offlineRootKey, symlink);
    await assert.rejects(loadPrivateKey(symlink), (error) => error.code === "CONFIG_INVALID");
});

test("MKT-04 publishes raw canonical item and release targets and refreshes only online roles", async (t) => {
    const { root } = await initializedRegistry(t);
    const store = await MarketplaceRegistryStore.open(root);
    t.after(() => store.close());
    const service = new MarketplaceRegistryService(store);
    const resource = await pluginFixtureResource();
    const artifact = (await service.admitArtifact(
        Buffer.from(JSON.stringify(resource)),
        { contentKind: "plugin" },
    )).descriptor;
    const aligned = marketplacePluginDocuments({ item: item(), release: documents.release, artifact, resource });
    await service.admitItem(marketplaceDocumentBytes(aligned.item));
    await service.admitRelease(marketplaceDocumentBytes(aligned.release));

    const before = await service.verifyRegistry();
    assert.equal(before.tuf.rootVersion, 1);
    assert.deepEqual(before.tuf.roleVersions, { targets: 1, catalog: 3, items: 2, publishers: 1, releases: 2, advisories: 1 });
    const releaseTarget = await store.tufRepository.readPublishedState()
        .then((state) => state.roles.releases.metadata.signed.targets[`releases/${aligned.release.itemId}/${aligned.release.releaseVersion}.json`]);
    assert.ok(releaseTarget);
    const targetFile = path.join(
        registryPaths(root).tufTargets,
        "releases",
        aligned.release.itemId,
        `${releaseTarget.hashes.sha256}.${aligned.release.releaseVersion}.json`,
    );
    assert.deepEqual(await fs.readFile(targetFile), Buffer.from(marketplaceDocumentBytes(aligned.release)));

    const refreshed = await store.mutate(async () => store.tufRepository.refresh(await store.readCatalog()));
    assert.equal(refreshed.timestampVersion, before.tuf.timestampVersion + 1);
    assert.equal(refreshed.snapshotVersion, before.tuf.snapshotVersion + 1);
    for (const role of TUF_DELEGATED_ROLES) assert.equal(refreshed.roleVersions[role], before.tuf.roleVersions[role] + 1);
    assert.equal((await service.verifyRegistry()).tuf.rootVersion, 1);

    await fs.writeFile(resolveRegistryPath(registryPaths(root), blobPath(artifact.sha256)), Buffer.alloc(artifact.sizeBytes));
    await assert.rejects(service.verifyRegistry(), (error) => error.code === "RECOVERY_REQUIRED");
});

test("MKT-04 upgrades a populated MKT-03 root without changing its registry identity", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-upgrade-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    const registry = await MarketplaceRegistryStore.initialize(root, { unsafeUnsignedDevelopment: true });
    let store = await MarketplaceRegistryStore.open(root);
    await new MarketplaceRegistryService(store).admitItem(marketplaceDocumentBytes(item()));
    await store.close();
    const upgraded = await MarketplaceRegistryStore.initialize(root, {
        registryId: registry.registryId,
        offlineRootKeyPath: path.join(parent, "offline-root.pem"),
    });
    assert.equal(upgraded.registryId, registry.registryId);
    const reader = await MarketplaceRegistryReader.open(root);
    const tuf = await reader.verify();
    assert.equal(tuf.catalogRevision, 2);
    assert.ok(await reader.readPublishedItem(documents.item.itemId));
});

test("MKT-04 resumes catalog publication after every durable TUF visibility boundary", async (t) => {
    for (const boundary of [
        "afterJournalDurability",
        "afterTargetPublication",
        "afterDelegatedMetadata",
        "afterSnapshotMetadata",
        "afterTimestampPublication",
        "beforeJournalCleanup",
    ]) {
        const parent = await fs.mkdtemp(path.join(os.tmpdir(), `cev-mkt-tuf-${boundary}-`));
        t.after(() => fs.rm(parent, { recursive: true, force: true }));
        const root = path.join(parent, "registry");
        await MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: path.join(parent, "root.pem"), unsafeUnsignedDevelopment: true });
        let injected = false;
        let store = await MarketplaceRegistryStore.open(root, {
            tufFaults: {
                [boundary]() {
                    if (!injected) {
                        injected = true;
                        throw new Error(`injected ${boundary}`);
                    }
                },
            },
        });
        await assert.rejects(
            new MarketplaceRegistryService(store).admitItem(marketplaceDocumentBytes(item())),
            new RegExp(boundary, "u"),
        );
        await store.close();
        assert.equal((await fs.readdir(registryPaths(root).tufTransactions)).length, 1, boundary);
        store = await MarketplaceRegistryStore.open(root);
        const verified = await new MarketplaceRegistryService(store).verifyRegistry();
        assert.equal(verified.revision, 2, boundary);
        assert.equal(verified.tuf.catalogRevision, 2, boundary);
        assert.deepEqual(await fs.readdir(registryPaths(root).tufTransactions), [], boundary);
        await store.close();
    }
});

test("MKT-04 recovers both overlap roots, rejects expiry, and maps signature failures", async (t) => {
    for (const boundary of ["afterTransitionRoot", "afterTimestampPublication", "afterFinalRoot"]) {
        const parent = await fs.mkdtemp(path.join(os.tmpdir(), `cev-mkt-root-${boundary}-`));
        t.after(() => fs.rm(parent, { recursive: true, force: true }));
        const root = path.join(parent, "registry");
        const oldKey = path.join(parent, "old.pem");
        const newKey = path.join(parent, "new.pem");
        await MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: oldKey });
        let injected = false;
        let store = await MarketplaceRegistryStore.open(root, {
            tufFaults: {
                [boundary]() {
                    if (!injected) {
                        injected = true;
                        throw new Error(`injected ${boundary}`);
                    }
                },
            },
        });
        await assert.rejects(
            store.mutate(() => store.tufRepository.rotateRoot({ currentRootKeyPath: oldKey, newRootKeyPath: newKey })),
            new RegExp(boundary, "u"),
        );
        await store.close();
        store = await MarketplaceRegistryStore.open(root);
        const tuf = (await new MarketplaceRegistryService(store).verifyRegistry()).tuf;
        assert.equal(tuf.rootVersion, 3, boundary);
        assert.deepEqual(
            (await fs.readdir(registryPaths(root).tufMetadata)).filter((name) => name.endsWith(".root.json")).sort(),
            ["1.root.json", "2.root.json", "3.root.json"],
            boundary,
        );
        await store.close();
    }

    const { root } = await initializedRegistry(t, "cev-mkt-tuf-expiry-");
    const reader = await MarketplaceRegistryReader.open(root);
    await assert.rejects(
        reader.verify({ now: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000) }),
        (error) => error.code === "METADATA_EXPIRED",
    );
    const timestampPath = path.join(registryPaths(root).tufMetadata, "timestamp.json");
    const timestamp = await fs.readFile(timestampPath, "utf8");
    const tampered = timestamp.replace(/("sig":")([a-f0-9])/u, (_match, prefix, first) => `${prefix}${first === "0" ? "1" : "0"}`);
    assert.notEqual(tampered, timestamp);
    await fs.writeFile(timestampPath, tampered);
    await assert.rejects(reader.verify(), (error) => error.code === "SIGNATURE_INVALID");
});

test("MKT-04 rejects a correctly signed timestamp rollback against immutable history", async (t) => {
    const { root } = await initializedRegistry(t, "cev-mkt-tuf-rollback-");
    const timestampPath = path.join(registryPaths(root).tufMetadata, "timestamp.json");
    const versionOne = await fs.readFile(timestampPath);
    let store = await MarketplaceRegistryStore.open(root);
    await store.mutate(async () => store.tufRepository.refresh(await store.readCatalog()));
    await store.close();
    await fs.writeFile(timestampPath, versionOne);
    store = await MarketplaceRegistryStore.open(root);
    await assert.rejects(
        new MarketplaceRegistryService(store).verifyRegistry(),
        (error) => error.code === "RECOVERY_REQUIRED" && /rolled back/u.test(error.message),
    );
    await store.close();
});
