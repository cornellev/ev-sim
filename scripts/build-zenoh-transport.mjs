#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPOSITORY_ROOT, parseOptions, run } from "./lib/headless-release-support.mjs";

const targets = { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" };
async function main() {
    if (process.platform !== "linux" || !targets[process.arch]) throw new Error("Build release Zenoh artifacts on Linux x64 or ARM64 in a glibc 2.31 build environment.");
    const options = parseOptions(process.argv.slice(2), { output: "dist/zenoh", target: targets[process.arch] });
    if (options.target !== targets[process.arch]) throw new Error("Native release builds require the matching host architecture.");
    const crate = path.join(REPOSITORY_ROOT, "native/zenoh-transport");
    const compiler = await run("rustc", ["--version"], { cwd: crate });
    if (compiler.code || !compiler.stdout.startsWith("rustc 1.98.0 ")) throw new Error("Native artifacts require pinned Rust 1.98.0.");
    const built = await run("cargo", ["build", "--locked", "--release", "--lib", "--target", options.target], { cwd: crate });
    if (built.code) throw new Error(built.stderr || built.stdout);
    const source = path.join(crate, "target", options.target, "release/libcev_zenoh_transport.so");
    const versions = await run("readelf", ["--version-info", source]);
    if (versions.code) throw new Error("readelf is required to verify the glibc baseline.");
    const glibc = [...versions.stdout.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map(([, major, minor]) => [Number(major), Number(minor)]);
    if (!glibc.length || glibc.some(([major, minor]) => major > 2 || (major === 2 && minor > 31))) throw new Error("Native artifact exceeds the glibc 2.31 release baseline.");
    const bytes = await fs.readFile(source);
    if (bytes.toString("ascii", 1, 4) !== "ELF" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (process.arch === "x64" ? 62 : 183)) throw new Error("Native artifact ELF architecture is incorrect.");
    const file = `cev-sim-zenoh-linux-${process.arch}.node`;
    const record = { kind: "cev-sim.zenoh-native-artifact", version: 1, file, platform: "linux", architecture: process.arch,
        target: options.target, minimumGlibc: "2.31", napiVersion: 8, zenohVersion: "1.10.2", rustVersion: "1.98.0",
        sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
        cargoLockSha256: createHash("sha256").update(await fs.readFile(path.join(crate, "Cargo.lock"))).digest("hex") };
    const output = path.resolve(options.output);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, file), bytes);
    await fs.writeFile(path.join(output, `${file}.json`), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(record)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
