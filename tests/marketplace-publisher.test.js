import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MarketplacePublicationCatalog } from "../server/marketplace/client/MarketplacePublicationCatalog.js";
import { MarketplacePublisherClient } from "../server/marketplace/client/MarketplacePublisherClient.js";
import {
    MarketplacePublicationDraftStore,
    MarketplacePublisherProfileStore,
    MarketplacePublisherSecretStore,
    createPublicationDraft,
    createPublisherProfile,
} from "../server/marketplace/client/MarketplacePublisherStores.js";
import { marketplaceClientPaths } from "../server/marketplace/client/MarketplaceClientLayout.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const SOURCE = Object.freeze({
    sourceId: "10000000-0000-4000-8000-000000000001",
    registryId: "20000000-0000-4000-8000-000000000001",
});

function item(itemId) {
    return {
        itemId,
        displayName: itemId,
        summary: "A durable publication draft.",
        description: "",
        categories: ["collection"],
        tags: [],
        links: [],
        previews: [],
    };
}

function release() {
    return {
        releaseVersion: "1.0.0",
        licenseExpression: "Apache-2.0",
        changelog: "Initial publication.",
        track: "stable",
        compatibility: {
            cevSim: ">=0.1.0 <0.2.0",
            contracts: [],
            platforms: [],
            architectures: [],
            runtimes: [],
            backends: [],
            features: [],
        },
    };
}

function collection(profileId, itemId, members = []) {
    return createPublicationDraft({
        profileId,
        contentKind: "collection",
        localSelection: { kind: "collection" },
        item: item(itemId),
        release: release(),
        members,
        now: NOW,
    });
}

test("MKT-14 publisher profiles, secrets, and drafts are private, revisioned, and cycle-safe", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-publisher-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const profiles = await MarketplacePublisherProfileStore.open(dataDir);
    const secrets = await MarketplacePublisherSecretStore.open(dataDir);
    const drafts = await MarketplacePublicationDraftStore.open(dataDir);
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

    const staged = await secrets.stage({ writeToken: "publisher-token-value", privateKeyPem });
    const profile = createPublisherProfile({
        source: SOURCE,
        name: "Production Publisher",
        publisherId: "com.example.publisher",
        keyId: staged.keyId,
        secretRef: staged.secretRef,
        now: NOW,
    });
    const added = await profiles.add(profile, 0);
    assert.equal(added.profile.secretConfigured, true);
    assert.equal(Object.hasOwn(added.profile, "secretRef"), false);
    assert.equal((await secrets.read(staged.secretRef)).writeToken, "publisher-token-value");

    const paths = marketplaceClientPaths(dataDir);
    assert.equal((await fs.stat(paths.publisherSecrets)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(paths.publisherSecrets, `${staged.secretRef}.json`))).mode & 0o777, 0o600);
    assert.doesNotMatch(await fs.readFile(paths.publisherProfiles, "utf8"), /publisher-token-value/u);
    assert.doesNotMatch(JSON.stringify(profiles.snapshot({ publicOnly: true })), /secretRef|publisher-token-value|PRIVATE KEY/u);

    const first = collection(profile.profileId, "com.example.first");
    assert.equal(first.state, "incomplete");
    await drafts.add(first, 0);
    const second = collection(profile.profileId, "com.example.second", [{ target: { type: "draft", draftId: first.draftId }, group: "Base" }]);
    assert.equal(second.state, "ready");
    await drafts.add(second, 1);
    await assert.rejects(
        drafts.update(first.draftId, { members: [{ target: { type: "draft", draftId: second.draftId }, group: null }] }, 0),
        (error) => error.code === "DOCUMENT_INVALID" && /cycle/u.test(error.message),
    );
    const crossRegistry = collection("50000000-0000-4000-8000-000000000001", "com.example.cross", [{ target: { type: "draft", draftId: first.draftId }, group: null }]);
    await assert.rejects(drafts.add(crossRegistry, 2), (error) => error.code === "DOCUMENT_INVALID" && /same publisher profile/u.test(error.message));
    await assert.rejects(drafts.remove(first.draftId, 2), (error) => error.code === "CONFLICT");

    const orphan = await secrets.stage({ writeToken: "orphan-token", privateKeyPem });
    await secrets.recover([staged.secretRef]);
    await assert.rejects(secrets.read(orphan.secretRef));
    assert.equal((await MarketplacePublisherProfileStore.open(dataDir)).snapshot().revision, 1);
    assert.equal((await MarketplacePublicationDraftStore.open(dataDir)).snapshot().drafts.length, 2);
    await assert.rejects(secrets.stage({ writeToken: "wrong-key", privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) }), (error) => error.code === "SIGNATURE_INVALID");
});

test("MKT-14 local publication catalog is deterministic, filterable, and excludes exact run packages", async () => {
    const storageService = {
        async listPluginLibrary() {
            return { revision: 7, packages: [{ pluginId: "zeta.plugin", version: "1.0.0", packageHash: "1".repeat(64), runtimeHash: "2".repeat(64) }] };
        },
        async listVehicleManifests() {
            return [{ id: "alpha-car", name: "Alpha Car", description: "A vehicle", revision: 2, definitionHash: "3".repeat(64), updatedAt: NOW.toISOString() }];
        },
        async listRunManifests() {
            return [{ id: "built-in-run", name: "Built-in Run", revision: 0, definitionHash: "4".repeat(64) }];
        },
        async listEnvironments() {
            return [{ id: "saved-yard", name: "Saved Yard", revision: 3, builtIn: false, sourceKind: "saved", updatedAt: NOW.toISOString() }];
        },
        async listRunPackages() {
            throw new Error("Exact run-package inventory must never be queried by the publisher catalog.");
        },
    };
    const editorAssetStore = {
        async list() {
            return { catalogRevision: 9, assets: [{ id: "forklift", name: "Forklift", latestRevision: 4, archived: false, tags: ["warehouse"], updatedAt: NOW.toISOString() }] };
        },
    };
    const catalog = new MarketplacePublicationCatalog({ storageService, editorAssetStore });
    const first = await catalog.list({ sort: "name", direction: "asc", offset: 0, limit: 2 });
    const second = await catalog.list({ sort: "name", direction: "asc", offset: 0, limit: 2 });
    assert.deepEqual(first, second);
    assert.equal(first.page.total, 5);
    assert.deepEqual(first.entries.map((entry) => entry.name), ["Alpha Car", "Built-in Run"]);
    assert.equal(first.entries.every((entry) => entry.publicationStatus === "unpublished"), true);
    assert.equal(first.entries[1].publishable, false);
    const assets = await catalog.list({ q: "warehouse", contentKind: "asset-pack", status: "publishable" });
    assert.deepEqual(assets.entries[0].localSelection, {
        kind: "asset-pack",
        roots: [{ assetId: "forklift", revision: 4 }],
        catalogRevision: 9,
    });
    const draftedCatalog = new MarketplacePublicationCatalog({
        storageService,
        editorAssetStore,
        draftStore: { snapshot: () => ({ drafts: [{
            localSelection: { kind: "plugin", packageHash: "1".repeat(64), libraryRevision: 7 },
            state: "ready",
        }] }) },
    });
    assert.equal((await draftedCatalog.list({ status: "drafted" })).entries[0].contentKind, "plugin");
    await assert.rejects(catalog.list({ contentKind: "run-package" }), (error) => error.code === "DOCUMENT_INVALID");
});

test("MKT-14 publisher transport permits only fixed-origin publication operations and rejects redirects", async () => {
    const requests = [];
    const client = new MarketplacePublisherClient({
        baseUrl: "https://registry.example.test/",
        writeToken: "secret-write-token",
        fetchImpl: async (url, init) => {
            requests.push({ url, init });
            return new Response(null, { status: 302, headers: { location: "https://attacker.example/" } });
        },
    });
    await assert.rejects(
        client.publishItem(Buffer.from("{}")),
        (error) => error.code === "SOURCE_UNAVAILABLE" && !error.message.includes("secret-write-token"),
    );
    assert.equal(requests[0].url, "https://registry.example.test/v1/items");
    assert.equal(requests[0].init.redirect, "manual");
    assert.equal(requests[0].init.headers.authorization, "Bearer secret-write-token");
    await assert.rejects(client.request("/v1/admin", { method: "POST", body: Buffer.alloc(0), mediaType: "application/json" }), (error) => error.code === "SOURCE_UNAVAILABLE");
    await assert.rejects(client.request("/v1/items", { method: "DELETE" }), /method is not allowed/u);
    const changedOrigin = new MarketplacePublisherClient({
        baseUrl: "https://registry.example.test/",
        writeToken: "secret-write-token",
        fetchImpl: async () => {
            const response = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
            Object.defineProperty(response, "url", { value: "https://attacker.example/v1/items" });
            return response;
        },
    });
    await assert.rejects(changedOrigin.publishItem(Buffer.from("{}")), (error) => error.code === "SOURCE_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(requests.map(({ url }) => url)), /secret-write-token/u);
});
