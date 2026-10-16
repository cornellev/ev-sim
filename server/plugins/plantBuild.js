import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalExactStringify, sha256ExactBytes } from "../../app/simulation/visual/VisualLayer.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../../app/plugin/PluginErrors.js";

const textEncoder = new TextEncoder();
const ROOT_FILES = ["plugin.json", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const DIAGNOSTIC_LIMIT = 64 * 1024;
const LOCAL_BUILDS_KIND = "cev-sim.plugin-local-builds";
const directoryLocks = new Map();

function withDirectoryLock(key, operation) {
    const previous = directoryLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    directoryLocks.set(key, run);
    return run.finally(() => {
        if (directoryLocks.get(key) === run) directoryLocks.delete(key);
    });
}

async function regularFileBytes(filePath) {
    try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        return new Uint8Array(await fs.readFile(filePath));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function collectSourceFiles(directory, relative, files) {
    let entries;
    try {
        entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) continue;
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
            await collectSourceFiles(directory, child, files);
            continue;
        }
        if (!entry.isFile()) continue;
        const bytes = await regularFileBytes(path.join(directory, child));
        if (!bytes) continue;
        files.push({ path: child, sha256: sha256ExactBytes(bytes) });
    }
}

export async function plantSourceFingerprint(directory) {
    const files = [];
    for (const name of ROOT_FILES) {
        const bytes = await regularFileBytes(path.join(directory, name));
        if (!bytes) continue;
        files.push({ path: name, sha256: sha256ExactBytes(bytes) });
    }
    await collectSourceFiles(directory, "src", files);
    files.sort((left, right) => left.path.localeCompare(right.path) || left.sha256.localeCompare(right.sha256));
    return sha256ExactBytes(textEncoder.encode(canonicalExactStringify(files)));
}

function buildFailure(message, cause = null) {
    const diagnostic = String(message ?? "").slice(-DIAGNOSTIC_LIMIT);
    return pluginError(PLUGIN_ERROR_CODES.BUILD_FAILED, diagnostic || "Plant build failed.", { cause });
}

export function defaultRunCargo({ cwd, targetDir, timeoutMs = BUILD_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        execFile("cargo", [
            "build",
            "--release",
            "--lib",
            "--locked",
            "--target",
            "wasm32-unknown-unknown",
            "--message-format=json-render-diagnostics",
        ], {
            cwd,
            env: { ...process.env, CARGO_TARGET_DIR: targetDir },
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                if (error.code === "ENOENT") {
                    reject(buildFailure("Install rustup to build plant plugins.", error));
                    return;
                }
                reject(buildFailure(`${stdout || ""}\n${stderr || ""}\n${error.message}`, error));
                return;
            }
            resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    });
}

function sourceUnderPackage(srcPath, packageDir) {
    if (!srcPath) return true;
    let value = String(srcPath);
    if (value.startsWith("file://")) {
        try {
            value = fileURLToPath(value);
        } catch {
            return false;
        }
    }
    const relative = path.relative(path.resolve(packageDir), path.resolve(value));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function selectPlantWasmArtifact(stdout, packageDir) {
    const artifacts = [];
    for (const line of String(stdout ?? "").split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            continue;
        }
        if (message.reason !== "compiler-artifact") continue;
        const srcPath = message.target?.src_path || "";
        if (srcPath && !sourceUnderPackage(srcPath, packageDir)) continue;
        const filenames = Array.isArray(message.filenames) ? message.filenames : [];
        for (const filename of filenames) {
            if (typeof filename === "string" && filename.endsWith(".wasm")) artifacts.push(filename);
        }
    }
    return artifacts.at(-1) ?? null;
}

export async function buildLocalPlantPackage({
    sourceDirectory,
    directoryKey,
    storeRoot,
    document,
    runCargo = defaultRunCargo,
} = {}) {
    if (!storeRoot) throw buildFailure("Plant builds require a plugin store root.");
    const modules = [...new Set((document?.plants ?? []).map((plant) => plant.module).filter(Boolean))];
    if (modules.length === 0) throw buildFailure("Plant build requires at least one declared module.");
    return withDirectoryLock(directoryKey || sourceDirectory, async () => {
        const fingerprint = await plantSourceFingerprint(sourceDirectory);
        const targetDir = path.join(storeRoot, "build-cache", fingerprint.slice(0, 32));
        await fs.mkdir(targetDir, { recursive: true });
        let result;
        try {
            result = await runCargo({ cwd: sourceDirectory, targetDir });
        } catch (error) {
            if (error?.code === PLUGIN_ERROR_CODES.BUILD_FAILED) throw error;
            throw buildFailure(error.message, error);
        }
        const artifact = selectPlantWasmArtifact(result.stdout, sourceDirectory);
        if (!artifact) throw buildFailure(result.stdout || result.stderr || "Cargo produced no plant WebAssembly artifact.");
        const wasm = await fs.readFile(artifact);
        const packageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plant-package-"));
        await fs.copyFile(path.join(sourceDirectory, "plugin.json"), path.join(packageDirectory, "plugin.json"));
        for (const modulePath of modules) {
            const destination = path.join(packageDirectory, modulePath);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, wasm);
        }
        return { packageDirectory, fingerprint, artifact };
    });
}

export function localBuildsPath(storeRoot) {
    return path.join(storeRoot, "local-builds.json");
}

export async function readLocalBuilds(storeRoot) {
    if (!storeRoot) return [];
    try {
        const parsed = JSON.parse(await fs.readFile(localBuildsPath(storeRoot), "utf8"));
        if (parsed?.kind !== LOCAL_BUILDS_KIND || parsed.version !== 1 || !Array.isArray(parsed.builds)) return [];
        return parsed.builds;
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

export async function recordLocalBuild(storeRoot, build) {
    const current = await readLocalBuilds(storeRoot);
    const next = current.filter((entry) => entry.directoryKey !== build.directoryKey);
    next.push({
        directoryKey: build.directoryKey,
        sourceFingerprint: build.sourceFingerprint,
        pluginId: build.pluginId,
        version: build.version,
        packageHash: build.packageHash,
    });
    next.sort((left, right) => left.directoryKey.localeCompare(right.directoryKey));
    const document = { kind: LOCAL_BUILDS_KIND, version: 1, builds: next };
    await fs.mkdir(storeRoot, { recursive: true });
    const destination = localBuildsPath(storeRoot);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
    await fs.rename(temporary, destination);
    return document;
}
