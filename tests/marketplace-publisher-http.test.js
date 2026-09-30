import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { MARKETPLACE_TOKEN_SCOPES } from "../server/marketplace/MarketplaceContract.js";
import { marketplaceDocumentBytes } from "../server/marketplace/MarketplaceContracts.js";
import { publisherKeyId, publisherPublicKey, verifyMarketplaceReleaseEnvelope } from "../server/marketplace/PublisherSignatures.js";
import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { RegistryAuthStore } from "../server/marketplace/registry/RegistryAuthStore.js";
import { MarketplaceRegistryHttpServer } from "../server/marketplace/registry/RegistryHttpServer.js";
import { registryPaths } from "../server/marketplace/registry/RegistryLayout.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";
import { StorageService } from "../server/storage/StorageService.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

function adminActor() {
    return { subject: "admin", publisherId: null, namespaces: [], scopes: MARKETPLACE_TOKEN_SCOPES };
}

async function waitForPublishJob(service, jobId, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const view = await service.getPublishJob(jobId);
        if (["complete", "failed", "needs-attention", "cancelled"].includes(view.job.phase)) return view;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Timed out waiting for Marketplace publication job.");
}

test("MKT-14 remote preview admission is scoped, typed, inspected, and idempotent", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-publisher-http-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, {
        registryId: "30000000-0000-4000-8000-000000000001",
        offlineRootKeyPath: path.join(parent, "root.pem"),
    });
    const auth = await RegistryAuthStore.open(registryPaths(root));
    const publisher = await auth.createToken({
        subject: "publisher",
        publisherId: "com.example.publisher",
        namespaces: ["com.example"],
        scopes: ["publish:blob"],
    });
    const wrongScope = await auth.createToken({
        subject: "publisher",
        publisherId: "com.example.publisher",
        namespaces: ["com.example"],
        scopes: ["publish:item"],
    });
    const server = await MarketplaceRegistryHttpServer.open(root, { writable: true });
    t.after(() => server.server.listening ? server.close() : undefined);
    const address = await server.listen({ port: 0 });
    const url = `http://127.0.0.1:${address.port}/v1/previews`;
    const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#4b6b5a" } }).png().toBuffer();
    const headers = { authorization: `Bearer ${publisher.token}`, "content-type": "image/png" };

    const first = await fetch(url, { method: "POST", headers, body: png });
    const admitted = await first.json();
    assert.equal(first.status, 201, JSON.stringify(admitted));
    assert.equal(admitted.descriptor.mediaType, "image/png");
    assert.equal(admitted.descriptor.sizeBytes, png.byteLength);
    assert.match(admitted.descriptor.sha256, /^[a-f0-9]{64}$/u);
    const replay = await fetch(url, { method: "POST", headers, body: png });
    assert.equal(replay.status, 201);
    assert.deepEqual((await replay.json()).descriptor, admitted.descriptor);

    const forbidden = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${wrongScope.token}`, "content-type": "image/png" },
        body: png,
    });
    assert.equal(forbidden.status, 403);
    const wrongType = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${publisher.token}`, "content-type": "image/svg+xml" },
        body: Buffer.from("<svg/>"),
    });
    assert.equal(wrongType.status, 400);
    const hostile = await fetch(url, { method: "POST", headers, body: Buffer.from("not a png") });
    assert.equal(hostile.status, 400);
    assert.doesNotMatch(await hostile.text(), new RegExp(publisher.token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    await server.close();
});

test("MKT-14 plugin publication prepares without mutation and commits an exact signed release", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-publish-e2e-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, {
        registryId: "40000000-0000-4000-8000-000000000001",
        offlineRootKeyPath: path.join(parent, "root.pem"),
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyId = publisherKeyId(publicKey);
    const timestamp = "2026-09-29T12:00:00.000Z";
    const publisher = {
        kind: "cev-sim.marketplace-publisher",
        version: 1,
        publisherId: "com.example.publisher",
        namespaces: ["acme.example", "test.range-image-fixture"],
        keys: [{
            keyId,
            algorithm: "ed25519",
            publicKey: publisherPublicKey(publicKey),
            status: "active",
            createdAt: timestamp,
            statusChangedAt: timestamp,
        }],
    };
    const store = await MarketplaceRegistryStore.open(root);
    await new (await import("../server/marketplace/registry/RegistryService.js")).MarketplaceRegistryService(store)
        .registerPublisher(marketplaceDocumentBytes(publisher), { actor: adminActor() });
    await store.close();
    const auth = await RegistryAuthStore.open(registryPaths(root));
    const credential = await auth.createToken({
        subject: "publisher",
        publisherId: publisher.publisherId,
        namespaces: publisher.namespaces,
        scopes: ["publish:blob", "publish:item", "publish:release", "manage:track"],
    });
    const server = await MarketplaceRegistryHttpServer.open(root, { writable: true });
    t.after(() => server.server.listening ? server.close() : undefined);
    const address = await server.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}/`;

    const dataDir = path.join(parent, "simulator");
    const storage = new StorageService(dataDir);
    const resource = await pluginFixtureResource();
    const verified = verifyPluginPackage(resource);
    await storage.installPluginFromBytes(Buffer.from(JSON.stringify(resource)));
    let service = await MarketplaceService.open(dataDir, {
        pluginStore: storage.plugins,
        storageService: storage,
        editorAssetStore: storage.editorAssets,
        visualAssetStore: storage.visualAssets,
    });
    t.after(() => service.close());
    const preview = await service.previewSource({ baseUrl });
    const added = await service.addSource({
        expectedRevision: 0,
        name: "Publication Registry",
        baseUrl,
        registryId: preview.registryId,
        trustedRootFingerprint: preview.trustedRootFingerprint,
        enabled: true,
        priority: 0,
    });
    await service.refreshSource(added.source.sourceId, { expectedRevision: 1 });
    const profileResult = await service.createPublisherProfile({
        expectedRevision: 0,
        name: "Release Publisher",
        sourceId: added.source.sourceId,
        publisherId: publisher.publisherId,
        writeToken: credential.token,
        privateKeyPem,
    });
    assert.equal(profileResult.profile.keyId, keyId);
    assert.equal(profileResult.profile.secretConfigured, true);
    assert.equal(Object.hasOwn(profileResult.profile, "secretRef"), false);
    const inventory = await service.listPublicationInventory({ contentKind: "plugin" });
    assert.equal(inventory.entries.length, 1);
    assert.equal(inventory.entries[0].identity.pluginId, verified.document.id);
    const draftResult = await service.createPublicationDraft({
        expectedRevision: 0,
        profileId: profileResult.profile.profileId,
        contentKind: "plugin",
        localSelection: inventory.entries[0].localSelection,
    });
    const release = { ...draftResult.draft.release, track: "stable" };
    const updated = await service.updatePublicationDraft(draftResult.draft.draftId, {
        expectedRevision: draftResult.draft.revision,
        release,
    });
    const before = await fetch(`${baseUrl}v1/catalog`).then((response) => response.json());
    const plan = await service.createPublicationPlan({ draftId: updated.draft.draftId, draftRevision: updated.draft.revision });
    assert.match(plan.entries[0].release.artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(plan.entries[0].release.executable.packageHash, resource.packageHash);
    assert.equal(plan.entries[0].release.compatibility.cevSim, verified.document.engines.cevSim);
    assert.deepEqual(plan.entries[0].release.compatibility.contracts, [{ kind: "cev-sim.plugin-package", versions: [1] }]);
    assert.deepEqual(await fetch(`${baseUrl}v1/catalog`).then((response) => response.json()), before);

    const job = await service.startPublishJob(plan.planHash);
    assert.equal(job.phase, "awaiting-confirmation");
    assert.deepEqual(await fetch(`${baseUrl}v1/catalog`).then((response) => response.json()), before);
    await service.commitPublishJob(job.jobId, { expectedRevision: job.revision, finalPlanHash: plan.planHash });
    const complete = await waitForPublishJob(service, job.jobId);
    assert.equal(complete.job.phase, "complete", JSON.stringify(complete.job.error));
    assert.equal(complete.job.progress.operationsComplete, complete.job.progress.operationsTotal);
    assert.equal(complete.job.progress.bytesComplete, complete.job.progress.bytesTotal);
    assert.deepEqual(complete.job.published, [{
        itemId: verified.document.id,
        releaseVersion: verified.document.version,
        artifactSha256: plan.entries[0].release.artifact.sha256,
    }]);
    const operations = await service.listPublishJobOperations(job.jobId, { offset: 0, limit: 20 });
    assert.equal(operations.entries.every((operation) => operation.status === "complete"), true);
    const remoteItem = await fetch(`${baseUrl}v1/items/${verified.document.id}`).then((response) => response.json());
    const remoteEnvelope = Buffer.from(await fetch(`${baseUrl}v1/items/${verified.document.id}/releases/${verified.document.version}`).then((response) => response.arrayBuffer()));
    const remoteRelease = verifyMarketplaceReleaseEnvelope(remoteEnvelope, publisher, { requireActive: true }).release;
    assert.equal(remoteItem.publisherId, publisher.publisherId);
    assert.equal(remoteRelease.artifact.sha256, plan.entries[0].release.artifact.sha256);
    assert.equal((await fetch(`${baseUrl}v1/catalog`).then((response) => response.json())).tracks[0].track, "stable");

    const nextResource = await pluginFixtureResource({ mutateDocument: (document) => { document.version = "1.1.0"; } });
    await storage.installPluginFromBytes(Buffer.from(JSON.stringify(nextResource)));
    const nextInventory = await service.listPublicationInventory({ contentKind: "plugin" });
    const nextEntry = nextInventory.entries.find((entry) => entry.identity.version === "1.1.0");
    const currentDrafts = await service.listPublicationDrafts();
    const nextDraftResult = await service.createPublicationDraft({
        expectedRevision: currentDrafts.revision,
        profileId: profileResult.profile.profileId,
        mode: "new-release",
        itemId: verified.document.id,
        contentKind: "plugin",
        localSelection: nextEntry.localSelection,
    });
    assert.equal(nextDraftResult.draft.item.displayName, remoteItem.displayName);
    assert.equal(nextDraftResult.draft.item.itemId, verified.document.id);
    const nextUpdated = await service.updatePublicationDraft(nextDraftResult.draft.draftId, {
        expectedRevision: nextDraftResult.draft.revision,
        release: { ...nextDraftResult.draft.release, track: "beta" },
    });
    const sensorResource = await pluginFixtureResource({ fixture: "test.range-image-fixture" });
    const verifiedSensor = verifyPluginPackage(sensorResource);
    await storage.installPluginFromBytes(Buffer.from(JSON.stringify(sensorResource)));
    const sensorEntry = (await service.listPublicationInventory({ contentKind: "plugin" })).entries.find((entry) => entry.identity.packageHash === sensorResource.packageHash);
    const sensorDraft = await service.createPublicationDraft({
        expectedRevision: (await service.listPublicationDrafts()).revision,
        profileId: profileResult.profile.profileId,
        contentKind: "plugin",
        localSelection: sensorEntry.localSelection,
    });
    const baseVehicle = createDefaultVehicleManifest({ id: "publisher-vehicle", name: "Publisher Vehicle" });
    const sensorType = verifiedSensor.document.sensorTypes[0].type;
    const vehicle = await storage.createVehicleManifest({
        ...baseVehicle,
        sensors: [...baseVehicle.sensors, {
            id: "published-sensor",
            type: sensorType,
            pose: { position: { x: 0, y: 0.8, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
            config: {},
        }],
        pluginLocks: [{
            pluginId: verifiedSensor.document.id,
            version: verifiedSensor.document.version,
            packageHash: verifiedSensor.resource.packageHash,
            runtimeHash: verifiedSensor.resource.runtimeHash,
            sensorTypes: [sensorType],
        }],
    });
    const vehicleEntry = (await service.listPublicationInventory({ contentKind: "vehicle" })).entries.find((entry) => entry.localId === vehicle.id);
    const vehicleDraft = await service.createPublicationDraft({
        expectedRevision: (await service.listPublicationDrafts()).revision,
        profileId: profileResult.profile.profileId,
        contentKind: "vehicle",
        localSelection: vehicleEntry.localSelection,
    });
    const vehiclePlan = await service.createPublicationPlan({ draftId: vehicleDraft.draft.draftId, draftRevision: vehicleDraft.draft.revision });
    assert.deepEqual(vehiclePlan.entries.map((entry) => entry.contentKind), ["plugin", "vehicle"]);
    assert.deepEqual(vehiclePlan.entries[1].release.embeddedPlugins[0].release, {
        itemId: verifiedSensor.document.id,
        releaseVersion: verifiedSensor.document.version,
        artifactSha256: vehiclePlan.entries[0].release.artifact.sha256,
    });
    assert.equal(vehiclePlan.entries[0].draftId, sensorDraft.draft.draftId);
    const refreshedNextEntry = (await service.listPublicationInventory({ contentKind: "plugin" })).entries.find((entry) => entry.identity.packageHash === nextResource.packageHash);
    const nextReady = await service.updatePublicationDraft(nextUpdated.draft.draftId, {
        expectedRevision: nextUpdated.draft.revision,
        localSelection: refreshedNextEntry.localSelection,
    });
    const nextPlan = await service.createPublicationPlan({ draftId: nextReady.draft.draftId, draftRevision: nextReady.draft.revision });
    const nextJob = await service.startPublishJob(nextPlan.planHash);
    await service.commitPublishJob(nextJob.jobId, { expectedRevision: nextJob.revision, finalPlanHash: nextPlan.planHash });
    const nextComplete = await waitForPublishJob(service, nextJob.jobId);
    assert.equal(nextComplete.job.phase, "complete", JSON.stringify(nextComplete.job.error));
    const catalog = await fetch(`${baseUrl}v1/catalog`).then((response) => response.json());
    assert.equal(catalog.releases.some((entry) => entry.itemId === verified.document.id && entry.releaseVersion === "1.1.0"), true);
    assert.equal(catalog.tracks.some((entry) => entry.itemId === verified.document.id && entry.track === "beta" && entry.releaseVersion === "1.1.0"), true);

    const memberResource = await pluginFixtureResource({ mutateDocument: (document) => { document.version = "1.2.0"; } });
    await storage.installPluginFromBytes(Buffer.from(JSON.stringify(memberResource)));
    const memberEntry = (await service.listPublicationInventory({ contentKind: "plugin" })).entries.find((entry) => entry.identity.version === "1.2.0");
    const memberDraftResult = await service.createPublicationDraft({
        expectedRevision: (await service.listPublicationDrafts()).revision,
        profileId: profileResult.profile.profileId,
        mode: "new-release",
        contentKind: "plugin",
        localSelection: memberEntry.localSelection,
    });
    const collectionResult = await service.createPublicationDraft({
        expectedRevision: (await service.listPublicationDrafts()).revision,
        profileId: profileResult.profile.profileId,
        contentKind: "collection",
        localSelection: { kind: "collection" },
        members: [{ target: { type: "draft", draftId: memberDraftResult.draft.draftId }, group: "New" }, {
            target: {
                type: "release",
                itemId: verified.document.id,
                releaseVersion: verified.document.version,
                artifactSha256: plan.entries[0].release.artifact.sha256,
            },
            group: "Stable",
        }],
    });
    const collectionPlan = await service.createPublicationPlan({
        draftId: collectionResult.draft.draftId,
        draftRevision: collectionResult.draft.revision,
    });
    assert.deepEqual(collectionPlan.entries.map((entry) => entry.contentKind), ["plugin", "collection"]);
    assert.deepEqual(collectionPlan.entries[1].release.dependencies, [
        { itemId: verified.document.id, releaseVersion: "1.2.0", artifactSha256: collectionPlan.entries[0].release.artifact.sha256 },
        { itemId: verified.document.id, releaseVersion: verified.document.version, artifactSha256: plan.entries[0].release.artifact.sha256 },
    ]);
    const collectionJob = await service.startPublishJob(collectionPlan.planHash);
    await service.commitPublishJob(collectionJob.jobId, { expectedRevision: collectionJob.revision, finalPlanHash: collectionPlan.planHash });
    const collectionComplete = await waitForPublishJob(service, collectionJob.jobId);
    assert.equal(collectionComplete.job.phase, "complete", JSON.stringify(collectionComplete.job.error));
    assert.equal(collectionComplete.job.published.at(-1).itemId, "acme.example.collection");
    const collectionOperations = await service.listPublishJobOperations(collectionJob.jobId, { offset: 0, limit: 20 });
    assert.equal(collectionOperations.entries.at(-1).itemId, "acme.example.collection");

    const interruptedResource = await pluginFixtureResource({ mutateDocument: (document) => { document.version = "1.3.0"; } });
    await storage.installPluginFromBytes(Buffer.from(JSON.stringify(interruptedResource)));
    const interruptedEntry = (await service.listPublicationInventory({ contentKind: "plugin" })).entries.find((entry) => entry.identity.version === "1.3.0");
    const interruptedDraft = await service.createPublicationDraft({
        expectedRevision: (await service.listPublicationDrafts()).revision,
        profileId: profileResult.profile.profileId,
        mode: "new-release",
        contentKind: "plugin",
        localSelection: interruptedEntry.localSelection,
    });
    const interruptedPlan = await service.createPublicationPlan({ draftId: interruptedDraft.draft.draftId, draftRevision: interruptedDraft.draft.revision });
    const interruptedJob = await service.startPublishJob(interruptedPlan.planHash);
    await service.close();
    let publicationWrites = 0;
    service = await MarketplaceService.open(dataDir, {
        pluginStore: storage.plugins,
        storageService: storage,
        editorAssetStore: storage.editorAssets,
        visualAssetStore: storage.visualAssets,
        fetchImpl: async (url, init = {}) => {
            if (String(url).startsWith(baseUrl) && ["POST", "PUT"].includes(init.method)) {
                publicationWrites += 1;
                if (publicationWrites === 2) throw new Error("injected network interruption");
            }
            return fetch(url, init);
        },
    });
    const recoveredAwaiting = await service.getPublishJob(interruptedJob.jobId);
    await service.commitPublishJob(interruptedJob.jobId, {
        expectedRevision: recoveredAwaiting.job.revision,
        finalPlanHash: interruptedPlan.planHash,
    });
    const interrupted = await waitForPublishJob(service, interruptedJob.jobId);
    assert.equal(interrupted.job.phase, "needs-attention");
    assert.equal(interrupted.job.progress.operationsComplete, 1);
    await service.close();
    service = await MarketplaceService.open(dataDir, {
        pluginStore: storage.plugins,
        storageService: storage,
        editorAssetStore: storage.editorAssets,
        visualAssetStore: storage.visualAssets,
    });
    const resumable = await service.getPublishJob(interruptedJob.jobId);
    await service.resumePublishJob(interruptedJob.jobId, resumable.job.revision);
    const resumed = await waitForPublishJob(service, interruptedJob.jobId);
    assert.equal(resumed.job.phase, "complete", JSON.stringify(resumed.job.error));
    assert.equal(resumed.job.progress.operationsComplete, resumed.job.progress.operationsTotal);
    const resumedOperations = await service.listPublishJobOperations(interruptedJob.jobId, { offset: 0, limit: 20 });
    assert.equal(resumedOperations.entries.filter((entry) => entry.status === "complete").length, resumed.job.progress.operationsTotal);

    const persisted = await fs.readFile(path.join(dataDir, "marketplace", "publisher", "profiles.json"), "utf8");
    assert.doesNotMatch(persisted, new RegExp(credential.token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(JSON.stringify(plan), /PRIVATE KEY|writeToken|secretRef/u);
    assert.doesNotMatch(JSON.stringify(complete), /PRIVATE KEY|writeToken|secretRef/u);
    await service.close();
    await server.close();
});
