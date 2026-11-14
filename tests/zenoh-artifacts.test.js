import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNativeArtifact } from "../native/zenoh-transport/index.js";
import { verifyZenohArtifact, collectZenohArtifacts, verifyZenohReleaseArtifacts } from "../scripts/lib/zenoh-artifacts.mjs";

function record(architecture, bytes) { return { kind: "cev-sim.zenoh-native-artifact", version: 1, platform: "linux", architecture,
    file: `cev-sim-zenoh-linux-${architecture}.node`, zenohVersion: "1.10.2", rustVersion: "1.98.0", napiVersion: 8,
    target: architecture === "x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu",
    minimumGlibc: "2.31", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), cargoLockSha256: "a".repeat(64) }; }
function elf(architecture) { const bytes = Buffer.alloc(64); bytes.write("\x7fELF"); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(architecture === "x64" ? 62 : 183, 18); return bytes; }

test("native artifacts require correct host, ABI, SDK and glibc identity", () => {
    const metadata = record("x64", elf("x64")), host = { platform: "linux", architecture: "x64", glibc: "2.31" };
    assert.equal(assertNativeArtifact(metadata, host), metadata);
    for (const override of [{ napiVersion: 9 }, { zenohVersion: "1.10.1" }, { file: "../bad.node" }]) assert.throws(() => assertNativeArtifact({ ...metadata, ...override }, host));
    assert.throws(() => assertNativeArtifact(metadata, { ...host, architecture: "arm64" }));
    assert.throws(() => assertNativeArtifact(metadata, { ...host, glibc: "2.28" }));
    assert.throws(() => assertNativeArtifact(metadata, { ...host, platform: "darwin" }));
});

test("artifact collection validates both architectures and rejects tampering", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-zenoh-artifacts-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(root, "output"); await fs.mkdir(output);
    for (const architecture of ["x64", "arm64"]) {
        const bytes = elf(architecture), metadata = record(architecture, bytes);
        await fs.writeFile(path.join(root, metadata.file), bytes); await fs.writeFile(path.join(root, `${metadata.file}.json`), JSON.stringify(metadata));
    }
    const records = await collectZenohArtifacts(root, output);
    assert.equal(records.length, 2);
    const manifest = { nativeTransports: records, artifacts: records };
    await verifyZenohReleaseArtifacts(output, manifest);
    await assert.rejects(verifyZenohReleaseArtifacts(output, { ...manifest, nativeTransports: [records[0]] }), /both Linux/);
    await assert.rejects(verifyZenohReleaseArtifacts(output, { ...manifest, artifacts: [] }), /checksum/);
    const metadata = record("x64", elf("x64")); await fs.writeFile(path.join(root, metadata.file), elf("arm64"));
    await assert.rejects(verifyZenohArtifact(root, metadata), /verification/);
});

test("onboarding router pins both architectures and rejects bytes before installation", async (t) => {
    const { installZenohRouter } = await import("../scripts/lib/zenoh-artifacts.mjs");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-router-install-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const pair = JSON.parse(await fs.readFile(new URL("./fixtures/protobuf/zenoh-browser-compatibility.json", import.meta.url)));
    for (const platform of ["linux", "darwin"]) for (const architecture of ["x64", "arm64"]) {
        assert.match(pair.artifacts[`${platform}-${architecture}`].sha256, /^[a-f0-9]{64}$/);
        await assert.rejects(installZenohRouter(root, { platform, architecture, fetchArchive: async () => new Uint8Array([1, 2, 3]) }), /checksum/);
    }
    assert.deepEqual(await fs.readdir(root), []);
});
