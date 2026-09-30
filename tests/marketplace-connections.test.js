import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalMarketplaceBytes } from "../server/marketplace/MarketplaceJson.js";
import { publisherKeyId } from "../server/marketplace/PublisherSignatures.js";
import {
    assertMarketplaceConnectionDocument,
    normalizeMarketplaceOrigin,
} from "../server/marketplace/client/MarketplaceConnectionDocuments.js";
import { MarketplaceConnectionPolicy } from "../server/marketplace/client/MarketplaceConnectionPolicy.js";
import { MarketplacePublicationBindingStore } from "../server/marketplace/client/MarketplacePublicationBindingStore.js";
import { MarketplacePublishingIdentityManager } from "../server/marketplace/client/MarketplacePublishingIdentityManager.js";
import {
    MARKETPLACE_CLIENT_DOCUMENT_VERSION,
    MARKETPLACE_CREDENTIAL_KIND,
} from "../server/marketplace/client/MarketplaceClientLayout.js";
import { MarketplaceService } from "../server/marketplace/client/MarketplaceService.js";
import { MarketplaceTrustClient } from "../server/marketplace/client/MarketplaceTrustClient.js";
import { createPopulatedClientRegistry } from "./helpers/marketplaceClientRegistry.js";

function credential(token = "reader-token") {
    return {
        kind: MARKETPLACE_CREDENTIAL_KIND,
        version: MARKETPLACE_CLIENT_DOCUMENT_VERSION,
        type: "bearer",
        token,
    };
}

function connection(origin, pin, overrides = {}) {
    return {
        kind: "cev-sim.marketplace-connection",
        version: 1,
        origin,
        displayName: "Company Marketplace",
        trustedRootSha256: pin,
        readCredentialFile: "read-credential.json",
        autoApprovePublisherIds: [],
        publishingIdentities: [],
        ...overrides,
    };
}

async function writeBundle(root, name, document, { credentialMode = 0o600 } = {}) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    const directory = path.join(root, name);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, "connection.json"), canonicalMarketplaceBytes(document), { mode: 0o600 });
    await fs.writeFile(path.join(directory, "read-credential.json"), canonicalMarketplaceBytes(credential()), { mode: credentialMode });
    return directory;
}

test("MKT-16 connection documents normalize origins and reject traversal or ambiguous defaults", () => {
    assert.equal(normalizeMarketplaceOrigin("https://marketplace.example"), "https://marketplace.example/");
    assert.throws(() => normalizeMarketplaceOrigin("https://marketplace.example/catalog"), /registry origin/u);
    assert.throws(() => assertMarketplaceConnectionDocument(connection("https://marketplace.example/", "a".repeat(64), {
        readCredentialFile: "../reader.json",
    })), /contained directly/u);
    assert.throws(() => assertMarketplaceConnectionDocument(connection("https://marketplace.example/", "a".repeat(64), {
        publishingIdentities: [{
            name: "One", publisherId: "acme.one", writeTokenFile: "one.token", privateKeyFile: "one.pem",
            default: false, defaults: { track: "stable", license: "Apache-2.0" },
        }],
    })), /exactly one/u);
});

test("MKT-16 connection policy enforces private regular files, unique origins, valid keys, and redaction", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-connections-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "connections.d");
    const keys = generateKeyPairSync("ed25519");
    const document = connection("https://marketplace.example/", "a".repeat(64), {
        autoApprovePublisherIds: ["acme.example"],
        publishingIdentities: [{
            name: "Product Team",
            publisherId: "acme.example",
            writeTokenFile: "publisher.token",
            privateKeyFile: "publisher.pem",
            default: true,
            defaults: { track: "stable", license: "Apache-2.0" },
        }],
    });
    const bundle = await writeBundle(root, "company", document);
    await fs.writeFile(path.join(bundle, "publisher.token"), "publisher-token", { mode: 0o600 });
    await fs.writeFile(path.join(bundle, "publisher.pem"), keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const policy = await MarketplaceConnectionPolicy.open(parent, { directory: root });
    const serialized = JSON.stringify(policy.list());
    assert.doesNotMatch(serialized, /reader-token|publisher-token|PRIVATE KEY|\.pem|\.token/u);
    assert.equal(policy.find(document.origin).credential.token, "reader-token");

    const duplicateRoot = path.join(parent, "duplicates");
    await writeBundle(duplicateRoot, "one", connection("https://same.example/", "b".repeat(64)));
    await writeBundle(duplicateRoot, "two", connection("https://same.example/", "c".repeat(64)));
    await assert.rejects(MarketplaceConnectionPolicy.open(parent, { directory: duplicateRoot }), /origins must be unique/u);

    const looseRoot = path.join(parent, "loose");
    await writeBundle(looseRoot, "loose", connection("https://loose.example/", "d".repeat(64)), { credentialMode: 0o644 });
    await assert.rejects(MarketplaceConnectionPolicy.open(parent, { directory: looseRoot }), /owner-only regular file/u);

    const linkedRoot = path.join(parent, "linked");
    const linkedBundle = await writeBundle(linkedRoot, "linked", connection("https://linked.example/", "e".repeat(64)));
    await fs.rm(path.join(linkedBundle, "read-credential.json"));
    await fs.symlink(path.join(bundle, "read-credential.json"), path.join(linkedBundle, "read-credential.json"));
    await assert.rejects(MarketplaceConnectionPolicy.open(parent, { directory: linkedRoot }), /owner-only regular file/u);
});

test("MKT-16 URL-only connection uses backend policy, refreshes immediately, and is idempotent", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-connect-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = await createPopulatedClientRegistry(parent, { signed: true });
    t.after(() => registry.server.close());
    const preview = await new MarketplaceTrustClient().previewSource({
        baseUrl: registry.baseUrl,
        credential: { type: "bearer", token: "reader-token" },
    });
    const dataDir = path.join(parent, "client");
    const policyRoot = path.join(dataDir, "marketplace", "connections.d");
    await writeBundle(policyRoot, "local", connection(registry.baseUrl, preview.trustedRootFingerprint));
    const service = await MarketplaceService.open(dataDir);
    t.after(() => service.close());

    const first = await service.connectSource({ baseUrl: registry.baseUrl });
    assert.equal(first.source.name, "Company Marketplace");
    assert.equal(first.source.health.status, "ready");
    assert.equal(first.catalog.catalogRevision > 0, true);
    assert.deepEqual(first.warnings, []);
    const repeated = await service.connectSource({ baseUrl: registry.baseUrl });
    assert.equal(repeated.source.sourceId, first.source.sourceId);
    assert.equal((await service.listSources()).sources.length, 1);
    await assert.rejects(service.connectSource({ baseUrl: "https://unknown.example/" }), (error) => error.code === "SOURCE_UNTRUSTED");
});

test("MKT-16 identity rotation keeps the newly referenced secret when old-secret cleanup fails", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" });
    const keyId = publisherKeyId(keys.privateKey);
    const source = {
        sourceId: "11111111-1111-4111-8111-111111111111",
        registryId: "22222222-2222-4222-8222-222222222222",
        baseUrl: "https://marketplace.example/",
    };
    const identity = {
        name: "Product Team",
        publisherId: "acme.example",
        writeToken: "rotated-token",
        privateKeyPem,
        default: true,
        defaults: { track: "stable", license: "Apache-2.0" },
    };
    const profile = {
        profileId: "33333333-3333-4333-8333-333333333333",
        sourceId: source.sourceId,
        publisherId: identity.publisherId,
        name: identity.name,
        keyId,
        secretRef: "44444444-4444-4444-8444-444444444444",
    };
    const removals = [];
    const updates = [];
    const manager = new MarketplacePublishingIdentityManager({
        connectionPolicy: {
            find: () => ({
                displayName: "Company Marketplace",
                autoApprovePublisherIds: [],
                identities: [identity],
            }),
        },
        sourceStore: { get: () => source },
        cache: {
            readCurrent: async () => ({
                documents: { publishers: [{ publisherId: identity.publisherId, keys: [{ keyId, status: "active" }] }] },
            }),
        },
        policyStore: { snapshot: async () => ({ registries: [] }) },
        profileStore: {
            snapshot: () => ({ revision: 7, profiles: [profile] }),
            update: async (...args) => updates.push(args),
        },
        secretStore: {
            read: async () => ({ writeToken: "old-token", privateKeyPem }),
            stage: async () => ({ secretRef: "55555555-5555-4555-8555-555555555555", keyId }),
            remove: async (secretRef) => {
                removals.push(secretRef);
                if (secretRef === profile.secretRef) throw new Error("simulated cleanup failure");
            },
        },
    });

    const readiness = await manager.reconcileSource(source.sourceId);
    assert.equal(readiness[0].status, "ready");
    assert.equal(updates.length, 1);
    assert.equal(updates[0][1].secretRef, "55555555-5555-4555-8555-555555555555");
    assert.deepEqual(removals, [profile.secretRef]);
});

test("MKT-16 verified publication binding recovery is idempotent", async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-bindings-"));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    let instant = new Date("2026-09-30T00:00:00.000Z");
    const store = await MarketplacePublicationBindingStore.open(dataDir, { now: () => instant });
    const binding = {
        profileId: "11111111-1111-4111-8111-111111111111",
        contentKind: "plugin",
        localIdentity: "plugin:acme.example",
        itemId: "acme.example",
        releaseVersion: "1.0.0",
        artifactSha256: "a".repeat(64),
    };
    const first = await store.upsert(binding);
    instant = new Date("2026-09-30T01:00:00.000Z");
    const repeated = await store.upsert(binding);
    assert.deepEqual(repeated, first);
    assert.equal(store.snapshot().revision, 1);
});
