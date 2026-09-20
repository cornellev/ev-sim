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
import {
    createHeadlessImu,
    createPluginPortableHeadlessBundle,
    createPluginRangeImageFixtureSensor,
    pluginSensorFixtureResource,
} from "../tests/helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "../tests/helpers/pluginFixtures.js";

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
    const installedPackage = JSON.parse(
        await fs.readFile(path.join(project, "node_modules/cev-sim/package.json"), "utf8"),
    );
    for (const name of ["acorn", "semver"]) {
        if (!installedPackage.dependencies?.[name]) {
            throw new Error(`Headless npm package must depend on ${name} for plugin verification.`);
        }
    }
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
    const pluginResource = await pluginFixtureResource();
    const pluginBundle = await createPluginPortableHeadlessBundle(pluginResource, {
        triggers: [{
            id: "finish", name: "Finish", enabled: true, once: true,
            condition: { kind: "step", step: 1 }, actions: [{ kind: "finish" }],
        }],
    });
    const pluginBundleFile = path.join(project, "plugin-bundle.json");
    const pluginEpisodeFile = path.join(project, "plugin-episode.json");
    await fs.writeFile(pluginBundleFile, canonicalRunBundleStringify(pluginBundle));
    await fs.writeFile(pluginEpisodeFile, JSON.stringify(episodeSpec(0, pluginBundle.resolvedHash, pluginBundle)));
    const pluginSmoke = await checked(executable, [
        "run", "--bundle", pluginBundleFile, "--episode", pluginEpisodeFile,
        "--output", path.join(project, "plugin-run-output"), "--artifact-profile", "disabled",
    ], { cwd: project, input: '{"policyStep":1,"action":[0,0]}\n' });
    const pluginRecords = pluginSmoke.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const pluginResult = pluginRecords.find((entry) => entry.kind === "cev-sim.headless.result");
    if (!pluginResult?.result?.passed) {
        throw new Error("Installed npm runtime did not complete the plugin bundle smoke episode.");
    }
    const provenance = pluginRecords.find((entry) => entry.kind === "cev-sim.headless.provenance")
        || pluginResult?.provenance;
    if (provenance?.plugins && !Array.isArray(provenance.plugins)) {
        throw new Error("Plugin provenance must be an array when present.");
    }
    if ((provenance?.plugins || []).some((entry) => entry.uiHash)) {
        throw new Error("Headless provenance must not include plugin uiHash.");
    }
    const installedLoader = await fs.readFile(path.join(project, "node_modules/cev-sim/app/plugin/PluginLoader.js"), "utf8");
    const installedSource = await fs.readFile(path.join(project, "node_modules/cev-sim/server/plugins/NodePluginModuleSource.js"), "utf8");
    if (installedLoader.includes("importUi") || installedSource.includes("importUi")) {
        throw new Error("Headless distribution loaded a UI module source.");
    }
    const browserUiPresent = await fs.access(path.join(project, "node_modules/cev-sim/app/plugin/browser"))
        .then(() => true, (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
        });
    if (browserUiPresent) throw new Error("Headless distribution shipped browser plugin UI modules.");

    const sensorResource = await pluginSensorFixtureResource();
    const sensorBundle = await createPluginPortableHeadlessBundle(sensorResource, {
        sensors: [createHeadlessImu(), createPluginRangeImageFixtureSensor()],
        triggers: [{
            id: "finish", name: "Finish", enabled: true, once: true,
            condition: { kind: "step", step: 1 }, actions: [{ kind: "finish" }],
        }],
    });
    const sensorBundleFile = path.join(project, "plugin-sensor-bundle.json");
    const sensorEpisodeFile = path.join(project, "plugin-sensor-episode.json");
    await fs.writeFile(sensorBundleFile, canonicalRunBundleStringify(sensorBundle));
    await fs.writeFile(sensorEpisodeFile, JSON.stringify(episodeSpec(
        0,
        sensorBundle.resolvedHash,
        sensorBundle,
        { perception: true },
    )));
    const sensorSmoke = await checked(executable, [
        "run", "--bundle", sensorBundleFile, "--episode", sensorEpisodeFile,
        "--output", path.join(project, "plugin-sensor-output"), "--artifact-profile", "disabled",
    ], { cwd: project, input: '{"policyStep":1,"action":[0,0]}\n' });
    const sensorRecords = sensorSmoke.stdout.trim().split("\n").map((line) => JSON.parse(line));
    if (!sensorRecords.some((entry) => entry.kind === "cev-sim.headless.result" && entry.result?.passed === true)) {
        throw new Error("Installed npm runtime did not complete the plugin sensor bundle smoke episode.");
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
