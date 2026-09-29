import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MARKETPLACE_LIMITS, MARKETPLACE_TOKEN_SCOPES } from "../server/marketplace/MarketplaceContract.js";
import { marketplaceDocumentBytes } from "../server/marketplace/MarketplaceContracts.js";
import {
    publisherKeyId,
    publisherPublicKey,
    signMarketplaceRelease,
    verifyMarketplaceReleaseEnvelope,
} from "../server/marketplace/PublisherSignatures.js";
import { MarketplaceExecutablePolicy } from "../server/marketplace/client/MarketplaceExecutablePolicy.js";
import { MarketplaceExecutableProvenanceStore } from "../server/marketplace/client/MarketplaceExecutableProvenanceStore.js";
import { MarketplacePolicyStore } from "../server/marketplace/client/MarketplacePolicyStore.js";
import { MarketplaceUpdateComparator } from "../server/marketplace/client/MarketplaceUpdateComparator.js";
import { MarketplaceUpdateModel } from "../server/marketplace/client/MarketplaceUpdateModel.js";
import { RegistryAuthStore } from "../server/marketplace/registry/RegistryAuthStore.js";
import { MarketplaceRegistryHttpServer } from "../server/marketplace/registry/RegistryHttpServer.js";
import { registryPaths } from "../server/marketplace/registry/RegistryLayout.js";
import { MarketplaceRegistryService } from "../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";
import { hashMarketplaceBytes } from "../server/marketplace/MarketplaceJson.js";
import { marketplacePluginDocuments } from "./helpers/marketplacePluginDocuments.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const documents = JSON.parse(await fs.readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));
const registryId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";

function adminActor() {
    return { subject: "admin", publisherId: null, namespaces: [], scopes: MARKETPLACE_TOKEN_SCOPES };
}

function publisherActor() {
    return {
        subject: "publisher",
        publisherId: "com.example.publisher",
        namespaces: ["acme.example"],
        scopes: ["publish:item", "publish:release", "manage:track", "manage:yank", "manage:advisory"],
    };
}

function publisherFor(publicKey, status = "active") {
    const timestamp = "2026-09-29T12:00:00.000Z";
    return {
        kind: "cev-sim.marketplace-publisher",
        version: 1,
        publisherId: "com.example.publisher",
        namespaces: ["acme.example"],
        keys: [{
            keyId: publisherKeyId(publicKey),
            algorithm: "ed25519",
            publicKey: publisherPublicKey(publicKey),
            status,
            createdAt: timestamp,
            statusChangedAt: timestamp,
        }],
    };
}

test("MKT-13 DSSE binds canonical payload, key ID, signature, and historical key material independently", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publisher = publisherFor(publicKey);
    const signed = signMarketplaceRelease(documents.release, privateKey);
    assert.equal(verifyMarketplaceReleaseEnvelope(signed.bytes, publisher, { requireActive: true }).keyId, publisher.keys[0].keyId);

    const retired = structuredClone(publisher);
    retired.keys[0].status = "retired";
    assert.equal(verifyMarketplaceReleaseEnvelope(signed.bytes, retired).release.releaseVersion, "1.2.3");
    assert.throws(() => verifyMarketplaceReleaseEnvelope(signed.bytes, retired, { requireActive: true }), /not active/u);

    const envelope = JSON.parse(Buffer.from(signed.bytes).toString("utf8"));
    const badSignature = structuredClone(envelope);
    badSignature.signatures[0].sig = `${badSignature.signatures[0].sig.slice(0, -4)}AAAA`;
    assert.throws(() => verifyMarketplaceReleaseEnvelope(badSignature, publisher), /signature/u);
    const badKey = structuredClone(envelope);
    badKey.signatures[0].keyid = "0".repeat(64);
    assert.throws(() => verifyMarketplaceReleaseEnvelope(badKey, publisher), /not registered/u);
    const badPayload = structuredClone(envelope);
    const release = JSON.parse(Buffer.from(badPayload.payload, "base64"));
    release.changelog = "Altered after signing.";
    badPayload.payload = Buffer.from(marketplaceDocumentBytes(release)).toString("base64");
    assert.throws(() => verifyMarketplaceReleaseEnvelope(badPayload, publisher), /signature/u);
    const badArtifact = structuredClone(envelope);
    const artifactRelease = JSON.parse(Buffer.from(badArtifact.payload, "base64"));
    artifactRelease.artifact.sha256 = "f".repeat(64);
    badArtifact.payload = Buffer.from(marketplaceDocumentBytes(artifactRelease)).toString("base64");
    assert.throws(() => verifyMarketplaceReleaseEnvelope(badArtifact, publisher), /signature/u);
    const duplicateSignature = structuredClone(envelope);
    duplicateSignature.signatures.push(structuredClone(duplicateSignature.signatures[0]));
    assert.throws(() => verifyMarketplaceReleaseEnvelope(duplicateSignature, publisher), /exactly one signature/u);
    const malformedBase64 = structuredClone(envelope);
    malformedBase64.payload = `${malformedBase64.payload}= `;
    assert.throws(() => verifyMarketplaceReleaseEnvelope(malformedBase64, publisher), /canonical base64/u);
    assert.throws(() => verifyMarketplaceReleaseEnvelope(Buffer.alloc(MARKETPLACE_LIMITS.jsonBytes + 1), publisher), /exceeds/u);
    assert.throws(() => verifyMarketplaceReleaseEnvelope(Buffer.concat([signed.bytes, Buffer.from("\n")]), publisher), /canonical/u);
});

test("MKT-13 bearer storage keeps only digests and enforces scope, namespace, and revocation", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt13-auth-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, { registryId });
    const auth = await RegistryAuthStore.open(registryPaths(root));
    const created = await auth.createToken({
        subject: "publisher",
        publisherId: "com.example.publisher",
        namespaces: ["com.example"],
        scopes: ["publish:release"],
    });
    const persisted = await fs.readFile(registryPaths(root).authTokens, "utf8");
    assert.doesNotMatch(persisted, new RegExp(created.token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.equal((await auth.authenticate(created.token, { scope: "publish:release", namespace: "com.example.item" })).publisherId, "com.example.publisher");
    await assert.rejects(auth.authenticate(created.token, { scope: "publish:item" }), (error) => error.code === "RIGHTS_DENIED");
    await assert.rejects(auth.authenticate(created.token, { scope: "publish:release", namespace: "org.other" }), (error) => error.code === "RIGHTS_DENIED");
    await auth.revokeToken(created.actor.tokenId);
    await assert.rejects(auth.authenticate(created.token), (error) => error.code === "SOURCE_UNTRUSTED");
    await assert.rejects(auth.authenticate(`00000000-0000-4000-8000-000000000000.${"A".repeat(43)}`), (error) => error.code === "SOURCE_UNTRUSTED");
});

test("MKT-13 private registry reads require scoped live tokens and plaintext LAN binds fail closed", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt13-http-auth-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, { registryId, offlineRootKeyPath: path.join(parent, "root.pem") });
    const auth = await RegistryAuthStore.open(registryPaths(root));
    const reader = await auth.createToken({ subject: "reader", scopes: ["read"] });
    const wrongScope = await auth.createToken({
        subject: "publisher",
        publisherId: "com.example.publisher",
        namespaces: ["com.example"],
        scopes: ["publish:item"],
    });
    const server = await MarketplaceRegistryHttpServer.open(root, { readAuthentication: true });
    t.after(() => server.close());
    await assert.rejects(server.listen({ host: "0.0.0.0", port: 0 }), /TLS and read authentication/u);
    const address = await server.listen({ port: 0 });
    const url = `http://127.0.0.1:${address.port}/v1/catalog`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${wrongScope.token}` } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${reader.token}` } })).status, 200);
    await auth.revokeToken(reader.actor.tokenId);
    const revoked = await fetch(url, { headers: { authorization: `Bearer ${reader.token}` } });
    assert.equal(revoked.status, 401);
    assert.doesNotMatch(await revoked.text(), new RegExp(reader.token, "u"));
});

test("MKT-13 signed registry admission, track, yank, and retired-key verification preserve exact releases", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt13-registry-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, { registryId });
    const store = await MarketplaceRegistryStore.open(root);
    t.after(() => store.close());
    const service = new MarketplaceRegistryService(store);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publisher = publisherFor(publicKey);
    await service.registerPublisher(marketplaceDocumentBytes(publisher), { actor: adminActor() });

    const resource = await pluginFixtureResource();
    const artifact = (await service.admitArtifact(Buffer.from(JSON.stringify(resource)), { contentKind: "plugin" })).descriptor;
    const aligned = marketplacePluginDocuments({
        item: { ...structuredClone(documents.item), previews: [] },
        release: {
            ...structuredClone(documents.release),
            executable: { pluginId: "acme.example", packageHash: resource.packageHash, runtimeHash: resource.runtimeHash },
        },
        artifact,
        resource,
    });
    await service.admitItem(marketplaceDocumentBytes(aligned.item), { actor: publisherActor() });
    const signed = signMarketplaceRelease(aligned.release, privateKey);
    await service.admitReleaseEnvelope(signed.bytes, { actor: publisherActor(), track: "stable" });
    assert.equal((await service.getRelease(aligned.release.itemId, aligned.release.releaseVersion)).artifact.sha256, artifact.sha256);
    await service.setPublisherKeyStatus(publisher.publisherId, publisher.keys[0].keyId, "retired", { actor: adminActor() });
    assert.equal((await service.getRelease(aligned.release.itemId, aligned.release.releaseVersion)).releaseVersion, aligned.release.releaseVersion);

    await service.yankRelease({
        itemId: aligned.release.itemId,
        releaseVersion: aligned.release.releaseVersion,
        artifactSha256: artifact.sha256,
        reason: "Known-bad controller behavior.",
    }, { actor: publisherActor() });
    const catalog = structuredClone(await store.readCatalog());
    assert.equal(catalog.tracks.some((entry) => entry.itemId === aligned.release.itemId), false);
    assert.equal(catalog.yanks.length, 1);
    assert.equal((await service.verifyRegistry()).ok, true);
});

test("MKT-13 unmarked pre-publisher registry state fails with UPGRADE_REQUIRED", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt13-upgrade-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, { registryId });
    const store = await MarketplaceRegistryStore.open(root);
    t.after(() => store.close());
    const catalog = { ...structuredClone(await store.readCatalog()) };
    delete catalog.releaseAuthority;
    const bytes = marketplaceDocumentBytes(catalog);
    const revisions = await fs.readdir(store.paths.catalogRevisions);
    assert.equal(revisions.length, 1);
    const replacement = `${catalog.revision}-${hashMarketplaceBytes(bytes)}.json`;
    await fs.writeFile(store.paths.catalogCurrent, bytes);
    await fs.rename(path.join(store.paths.catalogRevisions, revisions[0]), path.join(store.paths.catalogRevisions, replacement));
    await fs.writeFile(path.join(store.paths.catalogRevisions, replacement), bytes);
    await assert.rejects(
        new MarketplaceRegistryService(store).verifyRegistry(),
        (error) => error.code === "UPGRADE_REQUIRED",
    );
});

test("MKT-13 canonical package blocks persist offline, survive restart, and clear only by authorized supersession", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt13-policy-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const policyStore = await MarketplacePolicyStore.open(dataDir);
    const provenanceStore = await MarketplaceExecutableProvenanceStore.open(dataDir);
    const policy = new MarketplaceExecutablePolicy({ policyStore, provenanceStore });
    const packageHash = "b".repeat(64);
    const release = {
        ...structuredClone(documents.release),
        executable: { pluginId: "com.example.control", packageHash, runtimeHash: "c".repeat(64) },
    };
    const block = {
        ...structuredClone(documents.advisory),
        advisoryId: "com.example.block-2026-001",
        affected: [{ packageHash }],
        action: "block",
        severity: "critical",
    };
    await policyStore.ingestVerifiedSnapshot({
        source: { sourceId, registryId },
        manifest: { timestamp: { version: 5 }, snapshot: { sha256: "d".repeat(64) } },
        publishers: [{ publisherId: release.publisherId }],
        releases: [release],
        advisories: [block],
    });
    await policyStore.setPublisherApproval(registryId, release.publisherId, true);
    await provenanceStore.record(packageHash, {
        sourceId,
        registryId,
        publisherId: release.publisherId,
        release: { itemId: release.itemId, releaseVersion: release.releaseVersion, artifactSha256: release.artifact.sha256 },
        role: "direct",
    });
    await assert.rejects(policy.authorizePackage(packageHash), (error) => error.code === "RELEASE_BLOCKED");

    const reopenedPolicy = await MarketplacePolicyStore.open(dataDir);
    const reopened = new MarketplaceExecutablePolicy({ policyStore: reopenedPolicy, provenanceStore: await MarketplaceExecutableProvenanceStore.open(dataDir) });
    await assert.rejects(reopened.authorizePackage(packageHash), (error) => error.code === "RELEASE_BLOCKED");
    await assert.rejects(reopenedPolicy.ingestVerifiedSnapshot({
        source: { sourceId, registryId },
        manifest: { timestamp: { version: 4 }, snapshot: { sha256: "e".repeat(64) } },
    }), (error) => error.code === "SOURCE_UNTRUSTED");

    const clear = {
        ...structuredClone(block),
        advisoryId: "com.example.clear-2026-001",
        action: "clear",
        rationale: "The compromised key response is complete.",
        supersedes: [block.advisoryId],
    };
    await reopenedPolicy.ingestVerifiedSnapshot({
        source: { sourceId, registryId },
        manifest: { timestamp: { version: 6 }, snapshot: { sha256: "f".repeat(64) } },
        publishers: [{ publisherId: release.publisherId }],
        releases: [release],
        advisories: [block, clear],
    });
    assert.equal((await reopened.authorizePackage(packageHash)).blocked, false);
    const cycleA = { ...structuredClone(block), advisoryId: "com.example.cycle-a", supersedes: ["com.example.cycle-b"] };
    const cycleB = { ...structuredClone(block), advisoryId: "com.example.cycle-b", supersedes: ["com.example.cycle-a"] };
    await assert.rejects(reopenedPolicy.ingestVerifiedSnapshot({
        source: { sourceId, registryId },
        manifest: { timestamp: { version: 7 }, snapshot: { sha256: "9".repeat(64) } },
        publishers: [{ publisherId: release.publisherId }],
        releases: [release],
        advisories: [cycleA, cycleB],
    }), (error) => error.code === "RECOVERY_REQUIRED");
    assert.equal((await reopened.authorizePackage(packageHash)).blocked, false);
});

test("MKT-13 update discovery is exact-identity-only and comparison hashes every visible delta", async () => {
    const installed = {
        sourceId,
        registryId,
        release: { itemId: documents.release.itemId, releaseVersion: "1.2.3", artifactSha256: "a".repeat(64) },
        receiptHashes: ["1".repeat(64)],
    };
    const candidate = {
        ...structuredClone(documents.release),
        releaseVersion: "2.0.0",
        artifact: { ...structuredClone(documents.release.artifact), sha256: "2".repeat(64) },
        capabilities: ["signals.read.vehicles", "world.read"],
    };
    const summary = {
        itemId: candidate.itemId,
        releaseVersion: candidate.releaseVersion,
        artifact: candidate.artifact,
    };
    let currentRegistryId = registryId;
    let blocked = false;
    const model = new MarketplaceUpdateModel({
        sourceStore: { get: () => ({ sourceId, registryId: currentRegistryId, enabled: true }) },
        installedStore: { snapshot: async () => ({ installations: [installed] }) },
        cache: { readCurrent: async () => ({
            manifest: { snapshotId: "33333333-3333-4333-8333-333333333333" },
            catalog: {
                tracks: [{ itemId: candidate.itemId, track: "stable", releaseVersion: candidate.releaseVersion }],
                releases: [summary],
                yanks: [],
            },
            documents: { releases: [candidate] },
        }) },
        policyStore: { evaluateRelease: async () => ({ blocked }) },
    });
    const updates = await model.listUpdates({ track: "stable" });
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].identity, { sourceId, registryId, itemId: candidate.itemId });
    assert.equal(updates[0].from, installed);
    currentRegistryId = "44444444-4444-4444-8444-444444444444";
    assert.deepEqual(await model.listUpdates({ track: "stable" }), []);
    currentRegistryId = registryId;
    blocked = true;
    assert.deepEqual(await model.listUpdates({ track: "stable" }), []);

    const comparison = MarketplaceUpdateComparator.compare({
        installedRelease: documents.release,
        candidateRelease: candidate,
        installedCompatibility: { compatible: true, issues: [] },
        candidateCompatibility: { compatible: false, issues: [{ code: "HOST_INCOMPATIBLE" }] },
        installedAdapterPlan: { rights: [], mappings: [] },
        candidateAdapterPlan: { rights: [{ right: "authoring.write", allowed: false }], mappings: [{ sourceId: "new", localId: "new" }] },
        receiptMappings: [{ sourceId: "old", localId: "old" }],
    });
    assert.deepEqual(comparison.comparison.capabilities.added, ["signals.read.vehicles"]);
    assert.equal(comparison.comparison.compatibility.regression, true);
    assert.equal(comparison.comparison.rights.denied.length, 1);
    assert.match(comparison.comparisonHash, /^[a-f0-9]{64}$/u);
});
