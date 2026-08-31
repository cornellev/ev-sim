#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { HEADLESS_PROTOCOL } from "../server/headless/HeadlessProtocol.js";
import { RELEASE_MANIFEST_KIND, createReport } from "../server/headless/ReleaseReports.js";
import {
    REPOSITORY_ROOT,
    parseOptions,
    processProvenance,
    run,
} from "./lib/headless-release-support.mjs";

const NPM_TARBALL_LIMIT = 10 * 1024 * 1024;
const COPY_ENTRIES = Object.freeze([
    "bin",
    "proto",
    "server/headless",
    "server/logging",
    "server/storage",
    "docs/architecture.md",
    "docs/headless-cli.md",
    "docs/headless-release.md",
    "docs/headless-supervisor.md",
    "docs/jetson-headless.md",
    "docs/python-headless.md",
    "docs/run-manifests.md",
    "docs/sflog.md",
    "LICENSE",
]);
const JAVASCRIPT_ROOTS = Object.freeze(["bin", "server/headless", "server/logging", "server/storage"]);
const JAVASCRIPT_ENTRY_FILES = Object.freeze(["app/3d/devices/sensorEncode.worker.js"]);

async function readJson(file) {
    return JSON.parse(await fs.readFile(path.join(REPOSITORY_ROOT, file), "utf8"));
}

async function copyEntry(source, stage) {
    const absolute = path.join(REPOSITORY_ROOT, source);
    const destination = path.join(stage, source);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(absolute, destination, { recursive: true });
}

async function javascriptFiles(directory) {
    const files = [];
    for (const entry of await fs.readdir(path.join(REPOSITORY_ROOT, directory), { withFileTypes: true })) {
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await javascriptFiles(relative));
        else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relative);
    }
    return files;
}

async function requiredJavascriptFiles() {
    const queue = [
        ...(await Promise.all(JAVASCRIPT_ROOTS.map(javascriptFiles))).flat(),
        ...JAVASCRIPT_ENTRY_FILES,
    ];
    const files = new Set();
    while (queue.length > 0) {
        const relative = queue.pop();
        if (files.has(relative)) continue;
        files.add(relative);
        const source = await fs.readFile(path.join(REPOSITORY_ROOT, relative), "utf8");
        const imports = source.matchAll(/(?:from\s*|import\s*\(|import\s*)["'`]([^"'`]+)["'`]/g);
        for (const match of imports) {
            if (!match[1].startsWith(".")) continue;
            let dependency = path.normalize(path.join(path.dirname(relative), match[1]));
            if (!path.extname(dependency)) dependency += ".js";
            if (!dependency.endsWith(".js")) continue;
            await fs.access(path.join(REPOSITORY_ROOT, dependency));
            queue.push(dependency);
        }
    }
    return [...files];
}

function copiedByEntry(relative) {
    return COPY_ENTRIES.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
}

async function sha256(file) {
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function fileRecord(file) {
    const stat = await fs.stat(file);
    return { file: path.basename(file), sizeBytes: stat.size, sha256: await sha256(file) };
}

function packageMetadata(rootPackage) {
    const dependencies = Object.fromEntries([
        "@dimforge/rapier3d-compat",
        "@grpc/grpc-js",
        "@grpc/proto-loader",
        "@noble/hashes",
        "three",
        "three-mesh-bvh",
    ].map((name) => [name, rootPackage.dependencies[name]]));
    return {
        name: rootPackage.name,
        version: rootPackage.version,
        description: "Deterministic cev-sim headless CLI and process-isolated worker runtime",
        type: "module",
        license: "Apache-2.0",
        repository: { type: "git", url: "git+https://github.com/cornellev/ev-sim.git" },
        engines: { node: ">=22.14" },
        os: ["darwin", "linux"],
        cpu: ["x64", "arm64"],
        bin: { "cev-sim": "bin/cev-sim.js" },
        exports: {
            ".": "./server/headless/HeadlessRunner.js",
            "./protocol": "./server/headless/HeadlessProtocol.js",
            "./supervisor": "./server/headless/SupervisorServer.js",
            "./reports": "./server/headless/ReleaseReports.js",
        },
        dependencies,
        optionalDependencies: { "playwright-core": rootPackage.optionalDependencies["playwright-core"] },
    };
}

async function resolvePython() {
    if (process.env.PYTHON) return process.env.PYTHON;
    const virtualPython = path.join(REPOSITORY_ROOT, "python/.venv/bin/python");
    try {
        await fs.access(virtualPython);
        return virtualPython;
    } catch {
        return "python3";
    }
}

async function buildNpm(rootPackage, output, stage) {
    await Promise.all(COPY_ENTRIES.map((entry) => copyEntry(entry, stage)));
    const supportingFiles = (await requiredJavascriptFiles()).filter((file) => !copiedByEntry(file));
    await Promise.all(supportingFiles.map((file) => copyEntry(file, stage)));
    await fs.writeFile(path.join(stage, "package.json"), `${JSON.stringify(packageMetadata(rootPackage), null, 2)}\n`);
    await fs.writeFile(path.join(stage, "README.md"), [
        "# cev-sim headless runtime",
        "",
        "Internal release-candidate package for the deterministic CLI and process-isolated supervisor.",
        "The browser application is intentionally not installed or started by this package.",
        "See `docs/headless-cli.md` and `docs/headless-supervisor.md`.",
        "",
    ].join("\n"));
    const packed = await run("npm", [
        "pack",
        "--json",
        "--pack-destination", output,
        "--cache", path.join(output, ".npm-cache"),
    ], { cwd: stage });
    if (packed.code !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
    const records = JSON.parse(packed.stdout);
    const forbidden = records[0].files.map((entry) => entry.path).filter((name) => (
        /^(?:data|logs|public|tests)\//.test(name)
        || /\.(?:css|ico|jpe?g|log|png|sflog|svg|webp)$/i.test(name)
    ));
    if (forbidden.length > 0) throw new Error(`npm tarball contains excluded files: ${forbidden.join(", ")}`);
    const tarball = path.join(output, records[0].filename);
    const stat = await fs.stat(tarball);
    if (stat.size > NPM_TARBALL_LIMIT) {
        throw new Error(`npm tarball is ${stat.size} bytes; the release ceiling is ${NPM_TARBALL_LIMIT} bytes.`);
    }
    return tarball;
}

async function buildPython(output) {
    const python = await resolvePython();
    const pythonRoot = path.join(REPOSITORY_ROOT, "python");
    const stage = path.join(output, ".python-stage");
    const excluded = new Set([".pytest_cache", ".ruff_cache", ".venv", "__pycache__", "build", "dist"]);
    await fs.cp(pythonRoot, stage, {
        recursive: true,
        filter: (source) => !path.relative(pythonRoot, source).split(path.sep).some((part) => (
            excluded.has(part) || part.endsWith(".egg-info")
        )),
    });
    await fs.copyFile(path.join(REPOSITORY_ROOT, "LICENSE"), path.join(stage, "LICENSE"));
    try {
        const built = await run(python, ["-m", "build", "--no-isolation", "--outdir", output], { cwd: stage });
        if (built.code !== 0) throw new Error(`Python build failed: ${built.stderr || built.stdout}`);
        const files = (await fs.readdir(output))
            .filter((name) => name.endsWith(".whl") || name.endsWith(".tar.gz"))
            .map((name) => path.join(output, name));
        if (files.filter((name) => name.endsWith(".whl")).length !== 1
            || files.filter((name) => name.endsWith(".tar.gz")).length !== 1) {
            throw new Error("Python distribution must contain exactly one wheel and one sdist.");
        }
        const checked = await run(python, ["-m", "twine", "check", ...files]);
        if (checked.code !== 0) throw new Error(`twine check failed: ${checked.stderr || checked.stdout}`);
        const licenseCheck = await run(python, [
            "-c",
            [
                "import sys, tarfile, zipfile",
                "wheel, sdist = sys.argv[1:]",
                "wheel_names = zipfile.ZipFile(wheel).namelist()",
                "sdist_names = tarfile.open(sdist).getnames()",
                "assert any(name.endswith('/LICENSE') for name in wheel_names), wheel_names",
                "assert any(name.endswith('/LICENSE') for name in sdist_names), sdist_names",
            ].join("; "),
            files.find((name) => name.endsWith(".whl")),
            files.find((name) => name.endsWith(".tar.gz")),
        ]);
        if (licenseCheck.code !== 0) throw new Error(`Python artifacts omit LICENSE: ${licenseCheck.stderr}`);
        return files;
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
}

function pythonVersion(pyproject) {
    const match = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
    if (!match) throw new Error("python/pyproject.toml does not declare a project version.");
    return match[1];
}

async function main() {
    const options = parseOptions(process.argv.slice(2), { output: path.join(REPOSITORY_ROOT, "dist/headless") });
    const output = path.resolve(options.output);
    if (output === path.parse(output).root || output === REPOSITORY_ROOT) {
        throw new Error("Refusing to use a filesystem or repository root as the distribution output.");
    }
    const stage = path.join(output, ".npm-stage");
    const npmCache = path.join(output, ".npm-cache");
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(stage, { recursive: true });
    try {
        const rootPackage = await readJson("package.json");
        const pyproject = await fs.readFile(path.join(REPOSITORY_ROOT, "python/pyproject.toml"), "utf8");
        const npmTarball = await buildNpm(rootPackage, output, stage);
        const pythonFiles = await buildPython(output);
        const version = pythonVersion(pyproject);
        if (version !== rootPackage.version) throw new Error(`JavaScript ${rootPackage.version} and Python ${version} versions differ.`);
        const artifactFiles = [npmTarball, ...pythonFiles];
        const artifacts = await Promise.all(artifactFiles.map(fileRecord));
        const manifest = createReport(RELEASE_MANIFEST_KIND, {
            packageVersion: version,
            packages: { npm: version, python: version },
            protocol: { minimum: { major: 1, minor: 0 }, maximum: HEADLESS_PROTOCOL },
            contracts: {
                protobuf: "cev_sim.headless.v1",
                manifestVersion: 9,
                runBundleVersion: 1,
                sflogVersion: 1,
            },
            platforms: [
                { os: "linux", architectures: ["x64", "arm64"], node: ">=22.14", python: ">=3.10,<3.14" },
                { os: "macos", architectures: ["x64", "arm64"], node: ">=22.14", python: ">=3.10,<3.14" },
            ],
            provenance: processProvenance(),
            artifacts,
        });
        const manifestPath = path.join(output, "release-manifest.json");
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const records = [...artifacts, await fileRecord(manifestPath)];
        await fs.writeFile(
            path.join(output, "SHA256SUMS"),
            `${records.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n")}\n`,
        );
        process.stdout.write(`${JSON.stringify({ output, manifest })}\n`);
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
        await fs.rm(npmCache, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
