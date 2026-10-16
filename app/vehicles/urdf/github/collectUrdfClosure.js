/**
 * Dependency closure for one URDF entry.
 * Bytes come from `readFile`. This module does not fetch URLs.
 */

import { listMtlTexturePaths, listObjLibraryPaths } from "../../../editor-assets/mesh/ObjParser.js";
import { readGlb } from "../../../simulation/visual/GlbContainer.js";
import { listGltfDependencyPaths } from "../../model/vehiclePackagePaths.js";
import { urdfIssue } from "../issue.js";
import { parseUrdfRobot } from "../parseUrdfRobot.js";
import { readUrdfPackage, resolveUrdfResource } from "../urdfPackage.js";
import { GitHubUrdfError } from "./errors.js";
import { gitBlobSizeIssue, gitSubmoduleAncestor, gitTreeIssue, isGitLfsPointer } from "./gitTree.js";
import { GITHUB_URDF_LIMITS } from "./limits.js";

const GLB_OPTIONS = Object.freeze({
    requireTotalLength: true,
    requireAligned: true,
    requireLeadingJson: true,
    json: "last",
    jsonPadding: "whitespace",
    copyChunks: true,
    ErrorType: Error,
});

const HARD_CODES = new Set([
    "vehicle.github.depth",
    "vehicle.github.file-limit",
    "vehicle.github.file-bytes",
    "vehicle.github.package-bytes",
    "vehicle.urdf.xml-limit",
    "vehicle.github.symlink",
    "vehicle.github.submodule",
    "vehicle.github.lfs",
    "vehicle.github.size-mismatch",
    "vehicle.github.cancelled",
    "vehicle.github.deadline",
]);

function extensionOf(path) {
    return String(path).toLowerCase().split(".").at(-1);
}

function textOf(bytes) {
    return new TextDecoder().decode(bytes);
}

function isXmlPath(path) {
    const lower = String(path).toLowerCase();
    return lower.endsWith(".xml") || lower.endsWith(".urdf");
}

function packageXmlPaths(entries) {
    const paths = [];
    for (const path of entries.keys()) {
        if (path === "package.xml" || path.endsWith("/package.xml")) paths.push(path);
    }
    paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return paths;
}

function namedPackageXml(entries, name) {
    const found = [];
    if (entries.has("package.xml")) found.push("package.xml");
    for (const path of packageXmlPaths(entries)) {
        if (path === "package.xml") continue;
        const directory = path.slice(0, -"/package.xml".length);
        if (directory === name || directory.endsWith(`/${name}`)) found.push(path);
    }
    return found;
}

function issueFromError(error, path) {
    if (error instanceof GitHubUrdfError) return urdfIssue(error.code, error.path || path, error.message);
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        return urdfIssue("vehicle.github.cancelled", path, "GitHub acquisition was cancelled.");
    }
    return urdfIssue("vehicle.github.unavailable", path, error?.message || "GitHub acquisition failed.");
}

/**
 * Fetch the URDF entry and the meshes, buffers, MTL files, and textures it names.
 * A limit or hostile entry returns no package files.
 */
export async function collectUrdfClosure({
    entryPath,
    index,
    readFile,
    source = null,
    limits = GITHUB_URDF_LIMITS,
    signal = null,
} = {}) {
    const entries = index instanceof Map ? index : (index?.entries ?? new Map());
    const fetched = new Map();
    const scheduled = new Set();
    const diagnostics = [];
    const queue = [];
    const pending = [];
    let totalBytes = 0;
    let blocked = null;

    const block = (issue) => {
        if (!blocked) blocked = issue;
    };

    const currentPackage = () => readUrdfPackage({
        entryPath,
        files: [...fetched.entries()].map(([path, bytes]) => ({ path, bytes })),
        source: source ?? { kind: "local" },
    });

    const enqueue = (path, depth) => {
        if (!path || fetched.has(path) || scheduled.has(path) || blocked) return;
        if (depth > limits.maxDependencyDepth) {
            block(urdfIssue("vehicle.github.depth", path, `Dependency "${path}" exceeds depth ${limits.maxDependencyDepth}.`));
            return;
        }
        scheduled.add(path);
        queue.push({ path, depth });
    };

    const remember = (path, bytes) => {
        if (isGitLfsPointer(bytes)) {
            block(urdfIssue("vehicle.github.lfs", path, `File "${path}" is a Git LFS pointer.`));
            return false;
        }
        if (isXmlPath(path) && bytes.byteLength > limits.maxXmlBytes) {
            block(urdfIssue("vehicle.urdf.xml-limit", path, `URDF XML exceeds ${limits.maxXmlBytes} bytes.`));
            return false;
        }
        if (totalBytes + bytes.byteLength > limits.maxPackageBytes) {
            block(urdfIssue("vehicle.github.package-bytes", path, `The package exceeds ${limits.maxPackageBytes} bytes.`));
            return false;
        }
        fetched.set(path, bytes);
        totalBytes += bytes.byteLength;
        return true;
    };

    const readOne = async (path) => {
        if (signal?.aborted) {
            block(urdfIssue("vehicle.github.cancelled", path, "GitHub acquisition was cancelled."));
            return null;
        }
        const ancestor = gitSubmoduleAncestor(entries, path);
        if (ancestor) {
            block(urdfIssue("vehicle.github.submodule", path, `Path "${path}" is inside a submodule.`));
            return null;
        }
        const entry = entries.get(path) ?? null;
        const hostile = gitTreeIssue(entry, path);
        if (hostile) {
            block(hostile);
            return null;
        }
        const oversize = gitBlobSizeIssue(entry, limits.maxFileBytes);
        if (oversize) {
            block(oversize);
            return null;
        }
        if (fetched.size >= limits.maxFiles) {
            block(urdfIssue("vehicle.github.file-limit", path, `The package exceeds ${limits.maxFiles} files.`));
            return null;
        }
        if (Number.isFinite(entry.size) && totalBytes + entry.size > limits.maxPackageBytes) {
            block(urdfIssue("vehicle.github.package-bytes", path, `The package exceeds ${limits.maxPackageBytes} bytes.`));
            return null;
        }
        let bytes;
        try {
            bytes = await readFile(path, entry);
        } catch (error) {
            block(issueFromError(error, path));
            return null;
        }
        if (!(bytes instanceof Uint8Array)) {
            block(urdfIssue("vehicle.github.unavailable", path, `File "${path}" did not return bytes.`));
            return null;
        }
        if (Number.isFinite(entry.size) && bytes.byteLength !== entry.size) {
            block(urdfIssue("vehicle.github.size-mismatch", path, `File "${path}" size does not match the tree.`));
            return null;
        }
        if (!remember(path, bytes)) return null;
        return bytes;
    };

    const queueMesh = (fromPath, uri, depth) => {
        if (!uri || String(uri).toLowerCase().endsWith(".dae")) return;
        pending.push({ fromPath, uri, depth, phase: "start" });
    };

    const walkParsed = (path, bytes, depth) => {
        if (path !== entryPath) return;
        const parsed = parseUrdfRobot(bytes, { entryPath });
        diagnostics.push(...parsed.issues);
        if (!parsed.robot) return;
        for (const link of Object.values(parsed.robot.links)) {
            for (const element of [...link.visuals, ...link.collisions]) {
                if (element.geometry?.kind !== "mesh") continue;
                queueMesh(entryPath, element.geometry.filename, depth + 1);
            }
        }
    };

    const walkMesh = (path, bytes, depth) => {
        const extension = extensionOf(path);
        try {
            if (extension === "obj") {
                for (const library of listObjLibraryPaths(textOf(bytes), path)) enqueue(library, depth + 1);
                return;
            }
            if (extension === "mtl") {
                for (const texture of listMtlTexturePaths(textOf(bytes), path)) enqueue(texture, depth + 1);
                return;
            }
            if (extension !== "gltf" && extension !== "glb") return;
            const json = extension === "glb"
                ? readGlb(bytes, GLB_OPTIONS).json
                : JSON.parse(textOf(bytes));
            for (const dependency of listGltfDependencyPaths(json, path)) enqueue(dependency, depth + 1);
        } catch (error) {
            const code = /external/iu.test(error.message) ? "vehicle.urdf.external-uri" : "vehicle.urdf.unsupported-mesh";
            diagnostics.push(urdfIssue(code, path, error.message));
        }
    };

    const resolveRequest = (request) => {
        const resolved = resolveUrdfResource(currentPackage(), request.fromPath, request.uri);
        if (resolved.path && !resolved.missing) return;
        if (resolved.missing && resolved.path) {
            enqueue(resolved.path, request.depth);
            return;
        }
        if (resolved.packageName) {
            const named = namedPackageXml(entries, resolved.packageName);
            const waiting = named.filter((path) => !fetched.has(path) && !scheduled.has(path));
            if (request.phase !== "rest" && waiting.length > 0) {
                for (const path of waiting) enqueue(path, request.depth);
                pending.push({ ...request, phase: "named" });
                return;
            }
            const namedSet = new Set(named);
            const rest = packageXmlPaths(entries).filter((path) => !namedSet.has(path) && !fetched.has(path) && !scheduled.has(path));
            if (rest.length > 0) {
                enqueue(rest[0], request.depth);
                pending.push({ ...request, phase: "rest" });
                return;
            }
        }
        if (resolved.error) diagnostics.push(resolved.error);
    };

    enqueue(entryPath, 0);
    while (!blocked && (queue.length > 0 || pending.length > 0)) {
        if (queue.length > 0) {
            const item = queue.shift();
            const bytes = await readOne(item.path);
            if (!bytes || blocked) break;
            if (isXmlPath(item.path) && extensionOf(item.path) !== "xml") walkParsed(item.path, bytes, item.depth);
            else if (item.path === entryPath) walkParsed(item.path, bytes, item.depth);
            walkMesh(item.path, bytes, item.depth);
            continue;
        }
        resolveRequest(pending.shift());
    }

    if (blocked && HARD_CODES.has(blocked.code)) {
        return { ok: false, package: null, diagnostics: [blocked] };
    }
    if (blocked) diagnostics.push(blocked);
    const pkg = fetched.size === 0 ? null : currentPackage();
    const merged = [...diagnostics, ...(pkg?.diagnostics ?? [])];
    const failed = merged.some((entry) => entry.severity !== "info" && entry.severity !== "warning");
    return { ok: !failed && pkg != null, package: pkg, diagnostics: merged };
}
