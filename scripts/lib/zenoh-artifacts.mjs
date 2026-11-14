import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertNativeArtifact } from "../../native/zenoh-transport/index.js";

export async function verifyZenohArtifact(directory, record) {
    assertNativeArtifact(record, { platform: "linux", architecture: record.architecture, glibc: "2.31" });
    if (!/^[0-9a-f]{64}$/.test(record.cargoLockSha256)) throw new Error("Native artifact omits its pinned Cargo lock identity.");
    const bytes = await fs.readFile(path.join(directory, record.file));
    if (bytes.byteLength !== record.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256
        || bytes.byteLength < 64 || bytes.toString("ascii", 1, 4) !== "ELF" || bytes[0] !== 127 || bytes[4] !== 2 || bytes[5] !== 1
        || bytes.readUInt16LE(18) !== (record.architecture === "x64" ? 62 : 183)) throw new Error(`Native artifact ${record.file} failed identity/ELF/SHA-256 verification.`);
    return record;
}

export async function verifyZenohReleaseArtifacts(directory, manifest) {
    const records = manifest.nativeTransports ?? [];
    if (!Array.isArray(records) || (records.length !== 0 && (records.length !== 2
        || new Set(records.map((record) => record.architecture)).size !== 2
        || records[0].cargoLockSha256 !== records[1].cargoLockSha256))) throw new Error("Native release requires both Linux architectures built from the same Cargo lock.");
    for (const record of records) {
        await verifyZenohArtifact(directory, record);
        if (!manifest.artifacts?.some((artifact) => artifact.file === record.file && artifact.sha256 === record.sha256
            && artifact.sizeBytes === record.sizeBytes)) throw new Error("Native artifact is absent from the release checksum records.");
    }
}

export async function collectZenohArtifacts(directory, output) {
    if (!directory) return [];
    const records = [];
    for (const architecture of ["x64", "arm64"]) {
        const file = `cev-sim-zenoh-linux-${architecture}.node`;
        const record = JSON.parse(await fs.readFile(path.join(directory, `${file}.json`), "utf8"));
        await verifyZenohArtifact(directory, record);
        if (record.architecture !== architecture) throw new Error("Native artifact target does not match its filename.");
        await fs.copyFile(path.join(directory, file), path.join(output, file));
        records.push(record);
    }
    if (records[0].cargoLockSha256 !== records[1].cargoLockSha256) throw new Error("Native architectures were built from different Cargo locks.");
    return records;
}

export async function installZenohArtifact(dist, manifest, installedRoot) {
    const records = manifest.nativeTransports ?? [];
    if (!records.length || process.platform !== "linux") return null;
    const record = records.find((entry) => entry.platform === process.platform && entry.architecture === process.arch);
    if (!record) throw new Error("Release omits this host's native Zenoh artifact.");
    assertNativeArtifact(record);
    await verifyZenohArtifact(dist, record);
    const target = path.join(installedRoot, "native/zenoh-transport/prebuilds");
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(path.join(dist, record.file), path.join(target, record.file));
    await fs.writeFile(path.join(target, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
}

/** Install one checksum-pinned remote-API router in a versioned directory. */
export async function installZenohRouter(root, { platform = process.platform, architecture = process.arch, fetchArchive } = {}) {
    const pair = JSON.parse(await fs.readFile(new URL("../../tests/fixtures/protobuf/zenoh-browser-compatibility.json", import.meta.url)));
    const record = pair.artifacts[`${platform}-${architecture}`];
    if (!record) throw new Error(`Zenoh router is unavailable for ${platform}-${architecture}.`);
    const directory = path.join(path.resolve(root), `${pair.routerVersion}-${platform}-${architecture}`);
    const binary = path.join(directory, "zenoh-bridge-remote-api");
    const marker = { version: pair.routerVersion, archiveSha256: record.sha256 };
    try {
        const installed = JSON.parse(await fs.readFile(path.join(directory, "installed.json"), "utf8"));
        const bytes = await fs.readFile(binary);
        if (installed.archiveSha256 !== marker.archiveSha256 || installed.binarySha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("Installed router checksum changed.");
        return { binary, directory, version: pair.routerVersion };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const url = `https://github.com/eclipse-zenoh/zenoh-ts/releases/download/${pair.routerVersion}/${record.name}`;
    const bytes = fetchArchive ? await fetchArchive(url) : await (async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Router download failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
    })();
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new Error("Router archive checksum mismatch.");
    const { unzipSync } = await import("fflate");
    const contents = unzipSync(bytes)["zenoh-bridge-remote-api"];
    if (!contents?.length) throw new Error("Router archive omits the standalone executable.");
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const staging = await fs.mkdtemp(`${directory}.tmp-`);
    try {
        await fs.writeFile(path.join(staging, "zenoh-bridge-remote-api"), contents, { mode: 0o755 });
        await fs.writeFile(path.join(staging, "installed.json"), `${JSON.stringify({ ...marker, binarySha256: createHash("sha256").update(contents).digest("hex") })}\n`);
        await fs.rename(staging, directory);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    return { binary, directory, version: pair.routerVersion };
}
