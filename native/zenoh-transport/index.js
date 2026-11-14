import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "prebuilds");
const require = createRequire(import.meta.url);

export function assertNativeArtifact(record, { platform = process.platform, architecture = process.arch, glibc = process.report?.getReport()?.header.glibcVersionRuntime } = {}) {
    if (!record || record.kind !== "cev-sim.zenoh-native-artifact" || record.version !== 1
        || record.platform !== platform || record.architecture !== architecture || record.zenohVersion !== "1.10.2"
        || record.napiVersion !== 8 || record.rustVersion !== "1.98.0" || !/^[0-9a-f]{64}$/.test(record.sha256)
        || !/^[0-9a-f]{64}$/.test(record.cargoLockSha256)
        || record.target !== ({ x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" })[architecture]
        || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1
        || record.file !== `cev-sim-zenoh-${platform}-${architecture}.node`) throw new Error("Native Zenoh artifact identity is invalid or mismatches this host.");
    if (platform !== "linux" || !["x64", "arm64"].includes(architecture)) throw new Error("Native Zenoh release artifacts support Linux x64 and ARM64 only.");
    const [major, minor] = String(glibc ?? "").split(".").map(Number);
    if (record.minimumGlibc !== "2.31" || !Number.isInteger(major) || !Number.isInteger(minor)
        || major < 2 || (major === 2 && minor < 31)) throw new Error("Native Zenoh requires glibc 2.31 or newer.");
    return record;
}

export async function loadNativeBinding() {
    const record = assertNativeArtifact(JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")));
    const bytes = await fs.readFile(path.join(directory, record.file));
    if (bytes.byteLength !== record.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new Error("Native Zenoh artifact failed size/SHA-256 verification.");
    return { binding: require(path.join(directory, record.file)), artifact: record };
}

export async function openSession(config, wake) {
    const { binding, artifact } = await loadNativeBinding();
    const session = binding.createSession(JSON.stringify(config), wake);
    try { await session.openSession(); return { session, artifact }; }
    catch (error) { await session.close().catch(() => {}); throw error; }
}
