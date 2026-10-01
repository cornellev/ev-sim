import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enrollmentRootMatches, requestRegistryEnrollment } from "../server/marketplace/client/MarketplaceEnrollment.js";
import { publisherKeyId } from "../server/marketplace/PublisherSignatures.js";
import { RegistryAuthStore } from "../server/marketplace/registry/RegistryAuthStore.js";
import { MarketplaceRegistryHttpServer } from "../server/marketplace/registry/RegistryHttpServer.js";
import { registryPaths } from "../server/marketplace/registry/RegistryLayout.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const PUBLISHER_ID = "org.cornellev";
const DISPLAY_NAME = "Cornell Electric Vehicles Autonomy";
const WRITE_SCOPES = ["publish:blob", "publish:item", "publish:release", "manage:track"];

async function run(args) {
    const child = spawn(process.execPath, ["--experimental-default-type=module", "server/marketplace/cev-mkt.js", ...args], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    return { exitCode, stdout, stderr };
}

async function initializeRegistry(parent) {
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, { offlineRootKeyPath: path.join(parent, "root.pem") });
    return root;
}

async function fileContains(directory, needle) {
    const encoded = Buffer.from(needle);
    const visit = async (current) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                if (await visit(absolute)) return true;
            } else if (entry.isFile()) {
                const bytes = await fs.readFile(absolute);
                if (bytes.includes(encoded)) return true;
            }
        }
        return false;
    };
    return visit(directory);
}

test("enrollment responses fail closed without echoing a redirect target", async () => {
    const pin = "ab".repeat(32);
    assert.equal(enrollmentRootMatches(pin, pin), true);
    assert.equal(enrollmentRootMatches(pin, "cd".repeat(32)), false);
    assert.equal(enrollmentRootMatches(pin, "ab".repeat(31)), false);
    const missing = await requestRegistryEnrollment({
        baseUrl: "https://registry.example/",
        fetchImpl: async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 }),
    });
    assert.equal(missing, null);
    await assert.rejects(
        requestRegistryEnrollment({
            baseUrl: "https://registry.example/",
            fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/v1/enroll" } }),
        }),
        (error) => error.code === "SOURCE_UNAVAILABLE" && !error.message.includes("attacker.example"),
    );
});

test("enrollment serve flags require TLS, writable mode, and a publisher", async () => {
    const missingPublisher = await run([
        "serve", "--root", path.join(os.tmpdir(), "cev-mkt-enroll-unused"), "--enroll",
    ]);
    assert.equal(missingPublisher.exitCode, 2);
    assert.match(missingPublisher.stderr, /--enroll-publisher/);

    const missingTls = await run([
        "serve", "--root", path.join(os.tmpdir(), "cev-mkt-enroll-unused"),
        "--enroll", "--writable", "--enroll-publisher", PUBLISHER_ID, "--enroll-display-name", DISPLAY_NAME,
    ]);
    assert.equal(missingTls.exitCode, 2);
    assert.match(missingTls.stderr, /TLS and --writable/);

    const invalidPublisher = await run([
        "serve", "--root", path.join(os.tmpdir(), "cev-mkt-enroll-unused"),
        "--enroll", "--writable", "--tls-key", "missing.key", "--tls-cert", "missing.crt",
        "--enroll-publisher", "NOT-AN-ID", "--enroll-display-name", DISPLAY_NAME,
    ]);
    assert.equal(invalidPublisher.exitCode, 2);
    assert.match(invalidPublisher.stderr, /marketplace identifier/);
});

test("enrollment is absent unless enabled, and a read-only registry refuses it", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-enroll-off-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = await initializeRegistry(parent);
    const disabled = await MarketplaceRegistryHttpServer.open(root, { readAuthentication: true });
    t.after(() => disabled.close());
    const disabledAddress = await disabled.listen({ port: 0 });
    const disabledUrl = `http://127.0.0.1:${disabledAddress.port}/`;
    const hidden = await fetch(`${disabledUrl}v1/enroll`, { method: "POST" });
    assert.equal(hidden.status, 404);
    const discovery = await (await fetch(`${disabledUrl}.well-known/cev-sim-marketplace`)).json();
    assert.equal(Object.hasOwn(discovery, "enrollment"), false);
    assert.deepEqual(Object.keys(discovery).sort(), [
        "apiVersions", "authentication", "dnsSd", "kind", "limits", "registryId", "tuf", "version",
    ]);
    const protectedRoot = await fetch(new URL(discovery.tuf.bootstrapRootPath, disabledUrl));
    assert.equal(protectedRoot.status, 401);
    await disabled.close();

    const readOnly = await MarketplaceRegistryHttpServer.open(root, {
        readAuthentication: true,
        enrollment: { publisherId: PUBLISHER_ID, displayName: DISPLAY_NAME },
    });
    t.after(() => readOnly.close());
    const readOnlyAddress = await readOnly.listen({ port: 0 });
    const refused = await fetch(`http://127.0.0.1:${readOnlyAddress.port}/v1/enroll`, { method: "POST" });
    assert.equal(refused.status, 405);
});

test("enrollment registers one publisher, then adds a distinct key, and does not store secrets", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-enroll-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = await initializeRegistry(parent);
    const server = await MarketplaceRegistryHttpServer.open(root, {
        writable: true,
        readAuthentication: true,
        enrollment: { publisherId: PUBLISHER_ID, displayName: DISPLAY_NAME },
    });
    t.after(() => server.close());
    const address = await server.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}/`;

    const discoveryResponse = await fetch(`${baseUrl}.well-known/cev-sim-marketplace`);
    const discovery = await discoveryResponse.json();
    assert.equal(Object.hasOwn(discovery, "enrollment"), false);
    const rootResponse = await fetch(new URL(discovery.tuf.bootstrapRootPath, baseUrl));
    assert.equal(rootResponse.status, 200);
    const catalogResponse = await fetch(`${baseUrl}v1/catalog`);
    assert.equal(catalogResponse.status, 401);

    const firstResponse = await fetch(`${baseUrl}v1/enroll`, { method: "POST" });
    assert.equal(firstResponse.status, 201);
    assert.match(firstResponse.headers.get("cache-control"), /no-store/u);
    const first = await firstResponse.json();
    assert.equal(first.publisherId, PUBLISHER_ID);
    assert.equal(first.displayName, DISPLAY_NAME);
    assert.equal(first.bootstrapRootSha256, discovery.tuf.bootstrapRootSha256);
    assert.equal(publisherKeyId(createPrivateKey(first.privateKeyPem)), first.keyId);
    const secondResponse = await fetch(`${baseUrl}v1/enroll`, { method: "POST" });
    const second = await secondResponse.json();
    assert.notEqual(second.keyId, first.keyId);
    assert.notEqual(second.privateKeyPem, first.privateKeyPem);
    assert.notEqual(second.readToken, first.readToken);

    const publisherResponse = await fetch(`${baseUrl}v1/publishers/${PUBLISHER_ID}`, {
        headers: { authorization: `Bearer ${first.readToken}` },
    });
    assert.equal(publisherResponse.status, 200);
    const publisher = await publisherResponse.json();
    assert.deepEqual(publisher.namespaces, [PUBLISHER_ID]);
    assert.deepEqual(
        publisher.keys.map((key) => key.keyId).sort(),
        [first.keyId, second.keyId].sort(),
    );
    assert.equal(publisher.keys.every((key) => key.status === "active"), true);

    for (const secret of [first.privateKeyPem, first.readToken, first.writeToken, second.privateKeyPem, second.readToken, second.writeToken]) {
        assert.equal(await fileContains(root, secret), false);
    }
    await server.close();

    const auth = await RegistryAuthStore.open(registryPaths(root));
    assert.equal((await auth.authenticate(first.readToken, { scope: "read" })).subject, "reader");
    await assert.rejects(auth.authenticate(first.readToken, { scope: "publish:blob" }), (error) => error.code === "RIGHTS_DENIED");
    for (const scope of WRITE_SCOPES) {
        const actor = await auth.authenticate(first.writeToken, { scope });
        assert.equal(actor.subject, "publisher");
        assert.equal(actor.publisherId, PUBLISHER_ID);
        assert.deepEqual(actor.namespaces, [PUBLISHER_ID]);
    }
    await assert.rejects(auth.authenticate(first.writeToken, { scope: "manage:publisher" }), (error) => error.code === "RIGHTS_DENIED");
    await assert.rejects(auth.authenticate(first.writeToken, { scope: "manage:yank" }), (error) => error.code === "RIGHTS_DENIED");
});
