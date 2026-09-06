#!/usr/bin/env node
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { RELEASE_MANIFEST_KIND, assertReport } from "../server/headless/ReleaseReports.js";
import {
    createStateBundle,
    episodeSpec,
    parseOptions,
    run,
    temporaryRoot,
} from "./lib/headless-release-support.mjs";

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

async function verifyChecksums(dist, manifest) {
    const expected = new Map(manifest.artifacts.map((entry) => [entry.file, entry.sha256]));
    expected.set("release-manifest.json", await sha256(path.join(dist, "release-manifest.json")));
    const sums = parseChecksums(await fs.readFile(path.join(dist, "SHA256SUMS"), "utf8"));
    if (sums.size !== expected.size) throw new Error("SHA256SUMS contains unexpected or missing files.");
    for (const [name, digest] of expected) {
        if (sums.get(name) !== digest) throw new Error(`SHA256SUMS digest for ${name} is missing or incorrect.`);
    }
}

async function verifyNpm(root, tarball) {
    const project = path.join(root, "npm");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "package.json"), '{"name":"cev-sim-install-check","private":true}\n');
    await checked("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache", path.join(root, "npm-cache"),
        tarball,
    ], { cwd: project });
    const executable = path.join(project, "node_modules/.bin/cev-sim");
    const help = await checked(executable, ["--help"], { cwd: project });
    if (!help.stdout.includes("cev-sim supervisor")) throw new Error("Installed npm CLI did not expose headless commands.");
    await checked(process.execPath, [
        "--input-type=module",
        "-e",
        "await Promise.all(['cev-sim', 'cev-sim/protocol', 'cev-sim/supervisor', 'cev-sim/reports'].map((name) => import(name)));",
    ], { cwd: project });
    const bundle = await createStateBundle({
        triggers: [{
            id: "finish", name: "Finish", enabled: true, once: true,
            condition: { kind: "step", step: 1 }, actions: [{ kind: "finish" }],
        }],
    });
    const bundleFile = path.join(project, "bundle.json");
    const episodeFile = path.join(project, "episode.json");
    await fs.writeFile(bundleFile, canonicalRunBundleStringify(bundle));
    await fs.writeFile(episodeFile, JSON.stringify(episodeSpec(0, bundle.resolvedHash, bundle)));
    const smoke = await checked(executable, [
        "run", "--bundle", bundleFile, "--episode", episodeFile,
        "--output", path.join(project, "run-output"), "--artifact-profile", "disabled",
    ], { cwd: project, input: '{"policyStep":1,"action":[0,0]}\n' });
    const records = smoke.stdout.trim().split("\n").map((line) => JSON.parse(line));
    if (!records.some((entry) => entry.kind === "cev-sim.headless.result" && entry.result?.passed === true)) {
        throw new Error("Installed npm runtime did not complete the clean-install smoke episode.");
    }
}

async function verifyPython(root, artifact, index, expectedVersion) {
    const environment = path.join(root, `python-${index}`);
    const python = process.env.PYTHON || "python3";
    await checked(python, ["-m", "venv", environment]);
    const executable = path.join(environment, "bin/python");
    await checked(executable, ["-m", "pip", "install", "--disable-pip-version-check", artifact]);
    const imported = await checked(executable, [
        "-c",
        "import cev_sim; from cev_sim.headless.v1 import headless_pb2; print(cev_sim.__version__)",
    ]);
    if (imported.stdout.trim() !== expectedVersion) {
        throw new Error(`Installed Python artifact reported ${imported.stdout.trim()}; expected ${expectedVersion}.`);
    }
}

async function main() {
    const options = parseOptions(process.argv.slice(2), { dist: "dist/headless" });
    const dist = path.resolve(options.dist);
    const manifest = assertReport(
        JSON.parse(await fs.readFile(path.join(dist, "release-manifest.json"), "utf8")),
        RELEASE_MANIFEST_KIND,
    );
    await verifyChecksums(dist, manifest);
    const npmName = manifest.artifacts.find((entry) => entry.file.endsWith(".tgz"))?.file;
    const pythonNames = manifest.artifacts.filter((entry) => entry.file.endsWith(".whl") || entry.file.endsWith(".tar.gz"));
    if (!npmName || pythonNames.length !== 2) throw new Error("Distribution is missing npm, wheel, or sdist artifacts.");
    const root = await temporaryRoot("cev-headless-install-");
    try {
        await verifyNpm(root, path.join(dist, npmName));
        for (const [index, artifact] of pythonNames.entries()) {
            await verifyPython(root, path.join(dist, artifact.file), index, manifest.packages.python);
        }
        process.stdout.write(`${JSON.stringify({ ok: true, npm: npmName, python: pythonNames.map((entry) => entry.file) })}\n`);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
