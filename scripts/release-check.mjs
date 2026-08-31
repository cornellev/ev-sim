#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { HEADLESS_PROTOCOL } from "../server/headless/HeadlessProtocol.js";
import { RELEASE_MANIFEST_KIND, assertReport } from "../server/headless/ReleaseReports.js";
import { generateHeadlessCharacterization } from "../tests/helpers/headlessCharacterization.js";
import { REPOSITORY_ROOT, parseOptions } from "./lib/headless-release-support.mjs";

const NPM_TARBALL_LIMIT = 10 * 1024 * 1024;

async function read(relative) {
    return fs.readFile(path.join(REPOSITORY_ROOT, relative), "utf8");
}

function matchVersion(source, pattern, label) {
    const match = source.match(pattern);
    if (!match) throw new Error(`${label} version could not be read.`);
    return match[1];
}

async function sha256(file) {
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function parseChecksums(source) {
    const records = new Map();
    for (const line of source.trim().split("\n")) {
        const match = line.match(/^([0-9a-f]{64})  ([^/]+)$/);
        if (!match || records.has(match[2])) throw new Error(`Invalid SHA256SUMS entry: ${line}`);
        records.set(match[2], match[1]);
    }
    return records;
}

async function checkDistribution(directory, expectedVersion) {
    const root = path.resolve(directory);
    const manifest = assertReport(
        JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8")),
        RELEASE_MANIFEST_KIND,
    );
    if (manifest.packageVersion !== expectedVersion
        || manifest.packages?.npm !== expectedVersion
        || manifest.packages?.python !== expectedVersion) {
        throw new Error("Release-manifest package versions do not match the source authorities.");
    }
    if (manifest.protocol?.maximum?.major !== HEADLESS_PROTOCOL.major
        || manifest.protocol?.maximum?.minor !== HEADLESS_PROTOCOL.minor) {
        throw new Error("Release-manifest protocol range does not match the runtime.");
    }
    for (const artifact of manifest.artifacts || []) {
        const file = path.join(root, artifact.file);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size !== artifact.sizeBytes || await sha256(file) !== artifact.sha256) {
            throw new Error(`Release artifact ${artifact.file} does not match its manifest record.`);
        }
        if (artifact.file.endsWith(".tgz") && stat.size > NPM_TARBALL_LIMIT) {
            throw new Error(`npm tarball ${artifact.file} exceeds the 10 MiB ceiling.`);
        }
    }
    const names = manifest.artifacts.map((entry) => entry.file);
    if (names.filter((name) => name.endsWith(".tgz")).length !== 1
        || names.filter((name) => name.endsWith(".whl")).length !== 1
        || names.filter((name) => name.endsWith(".tar.gz")).length !== 1) {
        throw new Error("Release manifest must contain one npm tarball, wheel, and sdist.");
    }
    const sums = parseChecksums(await fs.readFile(path.join(root, "SHA256SUMS"), "utf8"));
    const expectedSums = new Map(manifest.artifacts.map((entry) => [entry.file, entry.sha256]));
    expectedSums.set("release-manifest.json", await sha256(path.join(root, "release-manifest.json")));
    if (sums.size !== expectedSums.size) throw new Error("SHA256SUMS contains unexpected or missing files.");
    for (const [name, digest] of expectedSums) {
        if (sums.get(name) !== digest) throw new Error(`SHA256SUMS digest for ${name} is missing or incorrect.`);
    }
    return manifest;
}

async function main() {
    const options = parseOptions(process.argv.slice(2), { dist: null });
    const rootPackage = JSON.parse(await read("package.json"));
    const plugin = JSON.parse(await read("plugin.json"));
    const pyproject = await read("python/pyproject.toml");
    const pythonInit = await read("python/src/cev_sim/__init__.py");
    const mcpRouter = await read("server/mcp/createMcpRouter.js");
    const versions = {
        package: rootPackage.version,
        plugin: plugin.version,
        pythonProject: matchVersion(pyproject, /^version\s*=\s*"([^"]+)"/m, "Python project"),
        pythonRuntime: matchVersion(pythonInit, /^__version__\s*=\s*"([^"]+)"/m, "Python runtime"),
        mcp: matchVersion(mcpRouter, /version:\s*"([^"]+)"/, "MCP"),
    };
    if (new Set(Object.values(versions)).size !== 1) {
        throw new Error(`Coordinated package versions differ: ${JSON.stringify(versions)}.`);
    }
    if (rootPackage.private !== true) throw new Error("The browser application root package must remain private.");
    if (rootPackage.license !== "Apache-2.0" || !/license\s*=\s*"Apache-2.0"/.test(pyproject)) {
        throw new Error("JavaScript and Python package metadata must use Apache-2.0.");
    }
    const license = await read("LICENSE");
    if (!license.includes("Apache License") || !license.includes("Version 2.0, January 2004")) {
        throw new Error("The repository Apache-2.0 license text is missing or incomplete.");
    }
    if (HEADLESS_PROTOCOL.major !== 1 || HEADLESS_PROTOCOL.minor !== 2) {
        throw new Error("PR 12 must not change the locked protocol 1.2 version.");
    }
    for (const relative of [
        "python/src/cev_sim/py.typed",
        "python/src/cev_sim/headless/v1/headless_pb2.py",
        "python/src/cev_sim/headless/v1/headless_pb2.pyi",
        "python/src/cev_sim/headless/v1/headless_pb2_grpc.py",
    ]) await fs.access(path.join(REPOSITORY_ROOT, relative));
    const tape = JSON.parse(await read("tests/fixtures/headless/action-tape.v1.json"));
    const expected = JSON.parse(await read("tests/fixtures/headless/characterization.v1.json"));
    const actual = await generateHeadlessCharacterization(tape);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("The PR 1 headless characterization fixture changed.");
    }
    const manifest = options.dist ? await checkDistribution(options.dist, rootPackage.version) : null;
    process.stdout.write(`${JSON.stringify({ ok: true, versions, protocol: HEADLESS_PROTOCOL, distribution: manifest })}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
