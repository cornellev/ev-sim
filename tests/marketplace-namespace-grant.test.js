import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MARKETPLACE_TOKEN_SCOPES } from "../server/marketplace/MarketplaceContract.js";
import { marketplaceDocumentBytes } from "../server/marketplace/MarketplaceContracts.js";
import { publisherKeyId, publisherPublicKey } from "../server/marketplace/PublisherSignatures.js";
import { RegistryAuthStore } from "../server/marketplace/registry/RegistryAuthStore.js";
import { registryPaths } from "../server/marketplace/registry/RegistryLayout.js";
import { MarketplaceRegistryService } from "../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";

const registryId = "11111111-1111-4111-8111-111111111111";
const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const PUBLISHER_ID = "org.cornellev";
const GRANTED = Object.freeze(["vendor.cornellev.dynamics", "vendor.robosense.helios32"]);

function adminActor() {
    return { subject: "admin", publisherId: null, namespaces: [], scopes: MARKETPLACE_TOKEN_SCOPES };
}

function publisherDocument(publicKey, publisherId, namespaces) {
    const timestamp = "2026-10-15T21:00:00.000Z";
    return {
        kind: "cev-sim.marketplace-publisher",
        version: 1,
        publisherId,
        namespaces: [...namespaces],
        keys: [{
            keyId: publisherKeyId(publicKey),
            algorithm: "ed25519",
            publicKey: publisherPublicKey(publicKey),
            status: "active",
            createdAt: timestamp,
            statusChangedAt: timestamp,
        }],
    };
}

function itemDocument(itemId, publisherId) {
    return {
        kind: "cev-sim.marketplace-item",
        version: 1,
        itemId,
        publisherId,
        contentKind: "plugin",
        displayName: itemId,
        summary: "Granted namespace publication.",
        description: "",
        categories: ["plugin"],
        tags: [],
        links: [],
        previews: [],
    };
}

function run(args) {
    const child = spawn(process.execPath, ["--experimental-default-type=module", "server/marketplace/cev-mkt.js", ...args], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
}

test("MKT-13 namespace grants let one publisher release foreign plugin ids and keep the same write token", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-namespace-grant-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, { registryId });
    const store = await MarketplaceRegistryStore.open(root);
    t.after(() => store.close());
    const service = new MarketplaceRegistryService(store);
    const { publicKey } = generateKeyPairSync("ed25519");
    const { publicKey: otherKey } = generateKeyPairSync("ed25519");
    await service.registerPublisher(marketplaceDocumentBytes(publisherDocument(publicKey, PUBLISHER_ID, [PUBLISHER_ID])), { actor: adminActor() });
    await service.registerPublisher(marketplaceDocumentBytes(publisherDocument(otherKey, "com.other", ["org.other"])), { actor: adminActor() });
    const auth = await RegistryAuthStore.open(registryPaths(root));
    const created = await auth.createToken({
        subject: "publisher",
        publisherId: PUBLISHER_ID,
        namespaces: [PUBLISHER_ID],
        scopes: ["publish:blob", "publish:item", "publish:release", "manage:track"],
    });
    const revoked = await auth.createToken({
        subject: "publisher",
        publisherId: PUBLISHER_ID,
        namespaces: [PUBLISHER_ID],
        scopes: ["publish:item"],
    });
    const other = await auth.createToken({
        subject: "publisher",
        publisherId: "com.other",
        namespaces: ["org.other"],
        scopes: ["publish:item"],
    });
    await auth.revokeToken(revoked.actor.tokenId);

    const dynamics = itemDocument(GRANTED[0], PUBLISHER_ID);
    await assert.rejects(
        service.admitItem(marketplaceDocumentBytes(dynamics), { actor: created.actor }),
        (error) => error.code === "CONFLICT" && /does not own its namespace/u.test(error.message),
    );
    await assert.rejects(
        service.grantPublisherNamespaces(PUBLISHER_ID, [GRANTED[0], "org.other.widget"], { actor: adminActor() }),
        (error) => error.code === "CONFLICT" && /overlaps an existing publisher namespace/u.test(error.message),
    );
    assert.deepEqual((await service.publisherStore.getPublisher(PUBLISHER_ID, await store.readCatalog())).namespaces, [PUBLISHER_ID]);

    const granted = await service.grantPublisherNamespaces(PUBLISHER_ID, GRANTED, { actor: adminActor() });
    assert.equal(granted.changed, true);
    assert.equal(granted.tokensUpdated, 1);
    assert.deepEqual(granted.namespaces, [PUBLISHER_ID, ...GRANTED].sort());
    const publisherActor = await auth.authenticate(created.token, { scope: "publish:item", namespace: GRANTED[1] });
    assert.equal(publisherActor.publisherId, PUBLISHER_ID);
    for (const itemId of GRANTED) {
        const admitted = await service.admitItem(marketplaceDocumentBytes(itemDocument(itemId, PUBLISHER_ID)), { actor: publisherActor });
        assert.equal(admitted.itemId, itemId);
        assert.equal(admitted.created, true);
    }
    const repeated = await service.grantPublisherNamespaces(PUBLISHER_ID, GRANTED, { actor: adminActor() });
    assert.equal(repeated.changed, false);
    assert.equal(repeated.tokensUpdated, 0);

    const enrolled = await service.enrollPublisher({ publisherId: PUBLISHER_ID, displayName: "CorEV Autonomy Marketplace" });
    const enrolledActor = await auth.authenticate(enrolled.writeToken, { scope: "publish:item", namespace: GRANTED[0] });
    assert.equal(enrolledActor.publisherId, PUBLISHER_ID);
    const document = await auth.read();
    assert.deepEqual(document.tokens.find((entry) => entry.tokenId === revoked.actor.tokenId).namespaces, [PUBLISHER_ID]);
    assert.deepEqual(document.tokens.find((entry) => entry.tokenId === other.actor.tokenId).namespaces, ["org.other"]);
    assert.equal((await service.verifyRegistry()).ok, true);
});

test("MKT-13 grant-namespace CLI updates the publisher without printing token material", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-namespace-cli-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    const offlineRootKey = path.join(parent, "offline-root.pem");
    const publisherPath = path.join(parent, "publisher.json");
    const { publicKey } = generateKeyPairSync("ed25519");
    await fs.writeFile(publisherPath, marketplaceDocumentBytes(publisherDocument(publicKey, PUBLISHER_ID, [PUBLISHER_ID])));
    assert.equal((await run(["init", "--root", root, "--offline-root-key", offlineRootKey, "--registry-id", registryId])).exitCode, 0);
    assert.equal((await run(["publisher", "register", "--root", root, "--file", publisherPath])).exitCode, 0);
    const token = await run([
        "token", "create", "--root", root, "--subject", "publisher", "--publisher-id", PUBLISHER_ID,
        "--namespace", PUBLISHER_ID, "--scope", "publish:item",
    ]);
    assert.equal(token.exitCode, 0);
    const secret = JSON.parse(token.stdout).token;
    const granted = await run([
        "publisher", "grant-namespace", "--root", root, "--publisher-id", PUBLISHER_ID,
        "--namespace", GRANTED.join(","),
    ]);
    assert.equal(granted.exitCode, 0, granted.stderr);
    assert.equal(granted.stderr, "");
    assert.doesNotMatch(granted.stdout, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    const result = JSON.parse(granted.stdout);
    assert.equal(result.operation, "grant-namespace");
    assert.equal(result.changed, true);
    assert.equal(result.tokensUpdated, 1);
    assert.deepEqual(result.namespaces, [PUBLISHER_ID, ...GRANTED].sort());
});
