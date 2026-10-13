/** Vehicle package paths. Editor-asset path rules stay unchanged. */

import { normalizedSelectedPath, resolveDependency } from "../../editor-assets/PackagePaths.js";

function fail(value, message) {
    throw new Error(`Import path ${JSON.stringify(value)} ${message}`);
}

function decodePath(value) {
    let text = String(value ?? "").replaceAll("\\", "/");
    try {
        text = decodeURIComponent(text);
    } catch {
        fail(value, "has invalid URI escapes.");
    }
    return text;
}

function normalizePublicPath(text, original) {
    if (text === "/api" || text.startsWith("/api/")) fail(original, "must be package-relative.");
    const parts = [];
    for (const part of text.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") fail(original, "traverses outside the package.");
        parts.push(part);
    }
    if (parts.length === 0) throw new Error("Import path cannot resolve to the package root.");
    return `/${parts.join("/")}`;
}

/** Package-relative paths use the editor normalizer. Public `/...` paths stay absolute. */
export function normalizeVehicleEntry(value) {
    const text = decodePath(value);
    if (text.startsWith("/")) return normalizePublicPath(text, value);
    return normalizedSelectedPath(text);
}

function assertInsidePublicDirectory(entry, resolved, raw) {
    const directory = entry.slice(0, entry.lastIndexOf("/"));
    if (resolved !== entry && !resolved.startsWith(`${directory}/`)) {
        fail(raw, "traverses outside the package.");
    }
}

/**
 * Resolve a glTF URI against a vehicle entry.
 * `data:` URIs return null. URLs and package escapes throw.
 */
export function resolveVehicleUri(entry, uri) {
    const raw = String(uri ?? "");
    if (raw.startsWith("data:")) return null;
    if (!raw || raw.startsWith("//") || raw.startsWith("\\") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        throw new Error(`External GLTF URI ${JSON.stringify(raw)} is not a selected package path.`);
    }
    if (entry.startsWith("/")) {
        if (raw.includes("\\") || raw.includes("..")) fail(raw, "traverses outside the package.");
        const resolved = raw.startsWith("/")
            ? normalizePublicPath(raw, raw)
            : normalizePublicPath(`${entry.slice(0, entry.lastIndexOf("/") + 1)}${raw}`, raw);
        assertInsidePublicDirectory(entry, resolved, raw);
        return resolved;
    }
    return resolveDependency(entry, raw);
}
