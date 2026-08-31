#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { RELEASE_MANIFEST_KIND, assertReport } from "../server/headless/ReleaseReports.js";
import { parseOptions, run } from "./lib/headless-release-support.mjs";

async function checked(command, args, options = {}) {
    const result = await run(command, args, options);
    if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result;
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

async function verify(dist) {
    const manifest = assertReport(
        JSON.parse(await fs.readFile(path.join(dist, "release-manifest.json"), "utf8")),
        RELEASE_MANIFEST_KIND,
    );
    if (!Array.isArray(manifest.artifacts)) throw new Error("Release manifest has no artifact records.");
    const expected = new Map();
    for (const artifact of manifest.artifacts) {
        const file = path.join(dist, artifact.file);
        const stat = await fs.stat(file);
        if (stat.size !== artifact.sizeBytes || await sha256(file) !== artifact.sha256) {
            throw new Error(`Artifact ${artifact.file} failed size or SHA-256 verification.`);
        }
        expected.set(artifact.file, artifact.sha256);
    }
    expected.set("release-manifest.json", await sha256(path.join(dist, "release-manifest.json")));
    const sums = parseChecksums(await fs.readFile(path.join(dist, "SHA256SUMS"), "utf8"));
    if (sums.size !== expected.size) throw new Error("SHA256SUMS contains unexpected or missing files.");
    for (const [name, digest] of expected) {
        if (sums.get(name) !== digest) throw new Error(`SHA256SUMS digest for ${name} is missing or incorrect.`);
    }
    return manifest;
}

async function main() {
    const options = parseOptions(process.argv.slice(2), {
        dist: "dist/headless",
        nodePrefix: null,
        pythonVenv: null,
        pythonArtifact: "wheel",
        verifyOnly: false,
    });
    const dist = path.resolve(options.dist);
    const manifest = await verify(dist);
    if (!options.verifyOnly && !options.nodePrefix && !options.pythonVenv) {
        throw new Error("Specify --node-prefix, --python-venv, or --verify-only.");
    }
    if (options.nodePrefix) {
        const npmArtifact = manifest.artifacts.find((entry) => entry.file.endsWith(".tgz"));
        if (!npmArtifact) throw new Error("Release does not contain an npm tarball.");
        await checked("npm", [
            "install", "--prefix", path.resolve(options.nodePrefix), "--ignore-scripts", "--no-audit", "--no-fund",
            path.join(dist, npmArtifact.file),
        ]);
    }
    if (options.pythonVenv) {
        const environment = path.resolve(options.pythonVenv);
        const python = path.join(environment, "bin/python");
        try { await fs.access(python); }
        catch { await checked(process.env.PYTHON || "python3", ["-m", "venv", environment]); }
        const suffix = options.pythonArtifact === "sdist" ? ".tar.gz" : ".whl";
        const pythonArtifact = manifest.artifacts.find((entry) => entry.file.endsWith(suffix));
        if (!pythonArtifact) throw new Error(`Release does not contain a Python ${options.pythonArtifact} artifact.`);
        await checked(python, ["-m", "pip", "install", path.join(dist, pythonArtifact.file)]);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.packageVersion, verified: manifest.artifacts.map((entry) => entry.file) })}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
