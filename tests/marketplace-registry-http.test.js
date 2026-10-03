import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Updater } from "tuf-js";

import { MARKETPLACE_CLIENT_LIMITS, MARKETPLACE_PUBLISHER_TRANSFER } from "../server/marketplace/MarketplaceContract.js";
import { marketplaceDocumentBytes } from "../server/marketplace/MarketplaceContracts.js";
import {
    MarketplaceRegistryHttpServer,
    assertLoopbackHost,
    parseRange,
    parseRequestPath,
} from "../server/marketplace/registry/RegistryHttpServer.js";
import { MarketplaceRegistryService } from "../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";
import { registryPaths } from "../server/marketplace/registry/RegistryLayout.js";
import { marketplacePluginDocuments } from "./helpers/marketplacePluginDocuments.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const documents = JSON.parse(await fs.readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));

function rawRequest(port, requestPath, { method = "GET", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port, path: requestPath, method, headers }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.once("end", () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
            }));
        });
        request.once("error", reject);
        request.end();
    });
}

async function populatedRegistry(t) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-http-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    const oldRootKey = path.join(parent, "old-root.pem");
    const newRootKey = path.join(parent, "new-root.pem");
    await MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: oldRootKey, unsafeUnsignedDevelopment: true });
    const store = await MarketplaceRegistryStore.open(root);
    const service = new MarketplaceRegistryService(store);
    const resource = await pluginFixtureResource();
    const artifactBytes = Buffer.from(JSON.stringify(resource));
    const artifact = (await service.admitArtifact(artifactBytes, { contentKind: "plugin" })).descriptor;
    const aligned = marketplacePluginDocuments({
        item: { ...structuredClone(documents.item), previews: [] },
        release: documents.release,
        artifact,
        resource,
    });
    const initialItem = structuredClone(aligned.item);
    await service.admitItem(marketplaceDocumentBytes(initialItem));
    await service.admitItem(marketplaceDocumentBytes({ ...initialItem, displayName: "Published Control Pack" }));
    await service.admitRelease(marketplaceDocumentBytes(aligned.release));
    await store.mutate(() => store.tufRepository.rotateRoot({
        currentRootKeyPath: oldRootKey,
        newRootKeyPath: newRootKey,
    }));
    await store.close();
    return { parent, root, artifact, artifactBytes, item: aligned.item, release: aligned.release };
}

test("MKT-04 raw route, host, and range parsers reject ambiguous inputs before I/O", () => {
    assert.equal(assertLoopbackHost("127.0.0.1"), "127.0.0.1");
    assert.equal(assertLoopbackHost("::1"), "::1");
    for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.20"]) assert.throws(() => assertLoopbackHost(host));
    for (const requestPath of ["/a//b", "/a/../b", "/a/%2f/b", "/a/%5c/b", "/a/%00", "/a?b", "/a#b", "/a\\b"]) {
        assert.equal(parseRequestPath(requestPath), null, requestPath);
    }
    assert.deepEqual(parseRequestPath("/v1/catalog"), ["v1", "catalog"]);
    assert.deepEqual(parseRange("bytes=0-0", 1), { start: 0, end: 0, length: 1 });
    assert.deepEqual(parseRange("bytes=-1", 3), { start: 2, end: 2, length: 1 });
    for (const range of ["items=0-1", "bytes=", "bytes=1-0", "bytes=0-1,3-4", "bytes=4-"]) {
        assert.equal(parseRange(range, 3), false, range);
    }
    assert.equal(parseRange(`bytes=0-${64 * 1024 * 1024}`, 128 * 1024 * 1024), false);
});

test("MKT-04 loopback API serves one atomic TUF view with exact HTTP and range semantics", async (t) => {
    const { root, artifact, artifactBytes, item, release } = await populatedRegistry(t);
    const server = await MarketplaceRegistryHttpServer.open(root);
    t.after(() => server.close());
    assert.equal(server.server.requestTimeout, MARKETPLACE_PUBLISHER_TRANSFER.capMs);
    assert.equal(server.server.headersTimeout, MARKETPLACE_CLIENT_LIMITS.requestTimeoutMs);
    const address = await server.listen({ port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;

    const discoveryResponse = await fetch(`${origin}/.well-known/cev-sim-marketplace`);
    const discoveryBytes = Buffer.from(await discoveryResponse.arrayBuffer());
    const discovery = JSON.parse(discoveryBytes);
    assert.equal(discovery.kind, "cev-sim.marketplace-registry-discovery");
    assert.equal(discovery.tuf.bootstrapRootPath, "/tuf/metadata/3.root.json");
    assert.deepEqual(discovery.authentication, { required: false, schemes: [] });
    assert.equal(discovery.limits.maxRangeBytes, 64 * 1024 * 1024);
    assert.equal(discovery.dnsSd.serviceType, "_cev-market._tcp");
    assert.equal(discoveryResponse.headers.get("content-length"), String(discoveryBytes.byteLength));
    assert.equal(discoveryResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(discoveryResponse.headers.get("access-control-allow-origin"), null);
    assert.match(discoveryResponse.headers.get("etag"), /^"[a-f0-9]{64}"$/u);

    const catalogResponse = await fetch(`${origin}/v1/catalog`);
    const catalogBytes = Buffer.from(await catalogResponse.arrayBuffer());
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogResponse.headers.get("content-type"), "application/vnd.cev-sim.marketplace-catalog+json");
    assert.equal(catalogResponse.headers.get("cache-control"), "no-cache");
    const catalogEtag = catalogResponse.headers.get("etag");
    assert.equal((await fetch(`${origin}/v1/catalog`, { headers: { "If-None-Match": catalogEtag } })).status, 304);

    const itemResponse = await fetch(`${origin}/v1/items/${item.itemId}`);
    assert.equal(itemResponse.status, 200);
    assert.equal((await itemResponse.json()).displayName, "Published Control Pack");
    const releaseResponse = await fetch(`${origin}/v1/items/${release.itemId}/releases/${release.releaseVersion}`);
    assert.equal(releaseResponse.status, 200);
    assert.deepEqual((await releaseResponse.json()).artifact, artifact);

    const blobPath = `/v1/blobs/sha256/${artifact.sha256}`;
    const full = await rawRequest(address.port, blobPath);
    assert.equal(full.status, 200);
    assert.deepEqual(full.body, artifactBytes);
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.equal(full.headers["content-type"], artifact.mediaType);
    const head = await rawRequest(address.port, blobPath, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.byteLength, 0);
    assert.equal(head.headers["content-length"], String(artifactBytes.byteLength));
    const first = await rawRequest(address.port, blobPath, { headers: { Range: "bytes=0-0" } });
    assert.equal(first.status, 206);
    assert.deepEqual(first.body, artifactBytes.subarray(0, 1));
    assert.equal(first.headers["content-range"], `bytes 0-0/${artifactBytes.byteLength}`);
    const suffix = await rawRequest(address.port, blobPath, { headers: { Range: "bytes=-7" } });
    assert.deepEqual(suffix.body, artifactBytes.subarray(-7));
    const ignored = await rawRequest(address.port, blobPath, { headers: { Range: "bytes=0-0", "If-Range": '"not-current"' } });
    assert.equal(ignored.status, 200);
    assert.deepEqual(ignored.body, artifactBytes);
    const multiple = await rawRequest(address.port, blobPath, { headers: { Range: "bytes=0-1,3-4" } });
    assert.equal(multiple.status, 416);
    assert.equal(multiple.headers["content-range"], `bytes */${artifactBytes.byteLength}`);
    const conditional = await rawRequest(address.port, blobPath, { headers: { "If-None-Match": full.headers.etag } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.body.byteLength, 0);

    const rootResponse = await fetch(`${origin}${discovery.tuf.bootstrapRootPath}`);
    assert.equal(rootResponse.status, 200);
    assert.equal(rootResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await fetch(`${origin}/tuf/metadata/1.snapshot.json`).then((response) => response.status), 404);
    const itemTargets = (await fs.readdir(path.join(registryPaths(root).tufTargets, "items"))).sort();
    assert.equal(itemTargets.length, 2);
    const staleItemTarget = itemTargets.find((name) => !name.startsWith(itemResponse.headers.get("etag").slice(1, -1)));
    assert.equal(await fetch(`${origin}/tuf/targets/items/${staleItemTarget}`).then((response) => response.status), 404);

    assert.equal((await rawRequest(address.port, "/v1/items/%2e%2e")).status, 400);
    const method = await rawRequest(address.port, "/v1/catalog", { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, "GET");
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${origin}/readyz`)).status, 200);

    const metadataDir = path.join(path.dirname(root), "client-metadata");
    const targetDir = path.join(path.dirname(root), "client-targets");
    await fs.mkdir(metadataDir);
    await fs.mkdir(targetDir);
    await fs.copyFile(path.join(registryPaths(root).tufMetadata, "1.root.json"), path.join(metadataDir, "root.json"));
    const updater = new Updater({
        metadataDir,
        metadataBaseUrl: `${origin}/tuf/metadata/`,
        targetDir,
        targetBaseUrl: `${origin}/tuf/targets/`,
    });
    await updater.refresh();
    const target = await updater.getTargetInfo("catalog/catalog.json");
    assert.ok(target);
    const downloaded = await updater.downloadTarget(target);
    assert.deepEqual(await fs.readFile(downloaded), catalogBytes);
});

test("MKT-04 concurrent readers see only the old or new timestamp publication", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-http-atomic-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: path.join(parent, "root.pem"), unsafeUnsignedDevelopment: true });
    let reachedBoundary;
    let releaseBoundary;
    const boundary = new Promise((resolve) => { reachedBoundary = resolve; });
    const gate = new Promise((resolve) => { releaseBoundary = resolve; });
    let paused = false;
    const store = await MarketplaceRegistryStore.open(root, {
        tufFaults: {
            async afterSnapshotMetadata() {
                if (paused) return;
                paused = true;
                reachedBoundary();
                await gate;
            },
        },
    });
    t.after(() => store.close());
    const server = await MarketplaceRegistryHttpServer.open(root);
    t.after(() => server.close());
    const address = await server.listen({ port: 0 });
    const origin = `http://127.0.0.1:${address.port}`;
    const admission = new MarketplaceRegistryService(store).admitItem(marketplaceDocumentBytes({
        ...structuredClone(documents.item),
        previews: [],
    }));
    await boundary;

    const oldViews = await Promise.all(Array.from({ length: 16 }, async () => {
        const response = await fetch(`${origin}/v1/catalog`);
        return { revision: (await response.json()).revision, etag: response.headers.get("etag") };
    }));
    assert.deepEqual(new Set(oldViews.map((entry) => entry.revision)), new Set([1]));
    assert.equal(new Set(oldViews.map((entry) => entry.etag)).size, 1);
    assert.equal((await fetch(`${origin}/readyz`)).status, 503);

    releaseBoundary();
    await admission;
    const newResponse = await fetch(`${origin}/v1/catalog`);
    assert.equal((await newResponse.json()).revision, 2);
    assert.notEqual(newResponse.headers.get("etag"), oldViews[0].etag);
    assert.equal((await fetch(`${origin}/readyz`)).status, 200);
});
