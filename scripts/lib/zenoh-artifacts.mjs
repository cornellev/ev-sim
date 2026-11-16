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

export { installZenohRouter } from "../../server/interfaces/ZenohLocalRouter.js";
