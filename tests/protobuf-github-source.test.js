import assert from "node:assert/strict";
import test from "node:test";
import { GitHubProtobufSource } from "../server/interfaces/GitHubProtobufSource.js";
import { PROTOBUF_SOURCE_LIMITS, loadUploadedProtoFiles } from "../server/interfaces/ProtobufSourceLoader.js";
import { createGitHubFixture, GITHUB_COMMIT_SHA } from "./helpers/github-urdf-fixtures.js";
import { importInput, protoV1, protoV2, temporaryStore } from "./helpers/protobufFixtures.js";

const source = { kind: "github", url: "https://github.com/acme/robot", ref: "main", entryFiles: ["proto/sample.proto"], includeDirs: ["proto"] };

test("ZPB-02 GitHub resolves branches, tags, file URLs, and exact commits to pinned closures", async () => {
    const files = {
        "proto/sample.proto": 'syntax = "proto3"; package test; import public "common.proto"; import "google/protobuf/timestamp.proto"; message Sample { Common value = 1; google.protobuf.Timestamp stamp = 2; }',
        "proto/common.proto": 'syntax = "proto3"; package test; message Common { uint64 count = 1; }',
    };
    const fixture = createGitHubFixture({ files, tags: ["v1"], branches: ["main", "feature/protobuf"] });
    const github = new GitHubProtobufSource({ fetchImpl: fixture.fetchImpl });
    for (const ref of ["main", "v1", "feature/protobuf", GITHUB_COMMIT_SHA]) {
        const pin = await github.resolveCommit({ ...source, ref });
        assert.equal(pin.commitSha, GITHUB_COMMIT_SHA);
        assert.notEqual(pin.commitSha, pin.treeSha);
        assert.equal(pin.requestedRef, ref);
        const closure = await github.fetchImportClosure(pin, source);
        assert.equal(closure.files.length, 2);
        assert.equal(closure.source.resolvedCommitSha, pin.commitSha);
        assert.ok(closure.root.lookupType("test.Sample"));
    }
    const pin = await github.resolveCommit({ url: `https://github.com/acme/robot/blob/${GITHUB_COMMIT_SHA}/proto/sample.proto` });
    const closure = await github.fetchImportClosure(pin);
    const upload = await loadUploadedProtoFiles({ entryFiles: source.entryFiles, includeDirs: source.includeDirs,
        files: Object.entries(files).map(([path, text]) => ({ path, bytesBase64: Buffer.from(text).toString("base64") })) });
    assert.equal(closure.fingerprint, upload.fingerprint);
    assert.equal(fixture.calls.some(({ url }) => url.includes("google/protobuf")), false);
    assert.ok(fixture.calls.every(({ init }) => init.redirect === "manual" && !init.headers.Authorization));
});

test("ZPB-02 GitHub refuses credentials, private repositories, redirects, mismatched pins and truncated trees", async () => {
    const github = new GitHubProtobufSource({ fetchImpl() { throw new Error("must not fetch"); } });
    await assert.rejects(github.resolveCommit({ ...source, url: "https://user:secret@github.com/acme/robot" }), /credentials/i);
    for (const options of [{ isPrivate: true }, { redirect: "https://evil.example" }]) {
        const fixture = createGitHubFixture(options);
        await assert.rejects(new GitHubProtobufSource({ fetchImpl: fixture.fetchImpl }).resolveCommit(source));
    }
    const fixture = createGitHubFixture({ files: { "proto/sample.proto": protoV1 }, truncated: true });
    const client = new GitHubProtobufSource({ fetchImpl: fixture.fetchImpl });
    await assert.rejects(client.resolveCommit({ ...source, ref: "f".repeat(40) }), /different commit/i);
    const pin = await client.resolveCommit(source);
    await assert.rejects(client.fetchImportClosure(pin, source), /truncated/i);
    const aborted = createGitHubFixture();
    await assert.rejects(new GitHubProtobufSource({ fetchImpl: aborted.fetchImpl }).resolveCommit(source, { signal: AbortSignal.abort() }), /cancelled/i);
    assert.equal(aborted.calls.length, 0);
});

test("ZPB-02 GitHub rejects symlinks, submodules, LFS, oversized and ambiguous source files", async () => {
    for (const options of [
        { modes: { "proto/sample.proto": "120000" } },
        { modes: { "proto": "160000" }, files: { proto: "", "proto/sample.proto": protoV1 } },
        { files: { "proto/sample.proto": "version https://git-lfs.github.com/spec/v1\noid sha256:abc" } },
        { sizes: { "proto/sample.proto": PROTOBUF_SOURCE_LIMITS.fileBytes + 1 } },
    ]) {
        const fixture = createGitHubFixture({ files: { "proto/sample.proto": protoV1 }, ...options });
        const github = new GitHubProtobufSource({ fetchImpl: fixture.fetchImpl });
        await assert.rejects(github.fetchImportClosure(await github.resolveCommit(source), source));
    }
    const fixture = createGitHubFixture({ files: { "left/sample.proto": protoV1, "right/sample.proto": protoV1 } });
    const github = new GitHubProtobufSource({ fetchImpl: fixture.fetchImpl });
    const selected = { ...source, entryFiles: ["left/sample.proto"], includeDirs: ["left", "right"] };
    await assert.rejects(github.fetchImportClosure(await github.resolveCommit(selected), selected), /Ambiguous/);
});

test("ZPB-02 shared GitHub requests cancel oversized streaming responses without Content-Length", async () => {
    const fixture = createGitHubFixture({ files: { "proto/sample.proto": protoV1 } });
    let cancelled = false;
    let chunks = 0;
    const github = new GitHubProtobufSource({ fetchImpl: async (url, init) => {
        if (!url.includes("/git/blobs/")) return fixture.fetchImpl(url, init);
        return new Response(new ReadableStream({
            pull(controller) { chunks++; controller.enqueue(new Uint8Array(400_000)); },
            cancel() { cancelled = true; },
        }));
    } });
    await assert.rejects(github.fetchImportClosure(await github.resolveCommit(source), source), /exceeds/);
    assert.equal(cancelled, true);
    assert.ok(chunks <= 4);
});

test("ZPB-02 GitHub checks new revisions without swapping the cache and applies the preview offline", async (t) => {
    const old = createGitHubFixture({ files: { "proto/sample.proto": protoV1 } });
    const newer = createGitHubFixture({ commitSha: "c".repeat(40), treeSha: "d".repeat(40), files: { "proto/sample.proto": protoV2 } });
    let current = old;
    const { store } = await temporaryStore(t, { fetchImpl: (url, init) => current.fetchImpl(url, init) });
    const imported = await store.importSources(importInput(source));
    current = newer;
    const check = await store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: 1 });
    assert.equal(check.candidateSource.resolvedCommitSha, newer.commitSha);
    assert.equal((await store.getSource("autonomy")).schemaSources[0].resolvedCommitSha, old.commitSha);
    store.github.fetchImpl = () => { throw new Error("offline"); };
    const applied = await store.applyUpdate("autonomy", { checkId: check.checkId, expectedRevision: check.revision, acceptInvalidations: true });
    assert.equal(applied.source.schemaSources[0].resolvedCommitSha, newer.commitSha);
    assert.deepEqual(await store.getByHash(imported.hash), imported.document);
    const before = await store.getSource("autonomy");
    await assert.rejects(store.checkUpdate("autonomy", { schemaId: "main", expectedRevision: before.revision }), { code: "PROTOBUF_ACQUISITION_FAILED" });
    assert.deepEqual(await store.getSource("autonomy"), before);
});

test("ZPB-02 GitHub closure reads stay on the resolved tree when the branch advances", async () => {
    const old = createGitHubFixture({ files: { "proto/sample.proto": protoV1 } });
    const newer = createGitHubFixture({ commitSha: "e".repeat(40), treeSha: "f".repeat(40), files: { "proto/sample.proto": protoV2 } });
    let advanced = false;
    const github = new GitHubProtobufSource({ fetchImpl: (url, init) => {
        if (url.includes("/commits/")) { const result = old.fetchImpl(url, init); advanced = true; return result; }
        if (url.includes("/git/")) return old.fetchImpl(url, init);
        return (advanced ? newer : old).fetchImpl(url, init);
    } });
    const pinned = await github.resolveCommit(source);
    const closure = await github.fetchImportClosure(pinned, source);
    assert.equal(advanced, true);
    assert.equal(closure.source.resolvedCommitSha, old.commitSha);
    assert.ok(closure.root.lookupType("test.State").fields.speed_mps);
    assert.equal(old.calls.filter(({ url }) => url.includes("/commits/")).length, 1);
});
