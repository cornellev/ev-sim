/** Local URDF package set. GitHub acquisition fills `source` later. */

import { parseUrdfXml, urdfXmlIssues } from "./parseUrdfXml.js";
import { urdfIssue } from "./issue.js";

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("URDF package files require bytes.");
}

export function normalizeUrdfPath(value) {
    let text = String(value ?? "").replaceAll("\\", "/");
    try {
        text = decodeURIComponent(text);
    } catch {
        throw new Error(`Import path ${JSON.stringify(value)} has invalid URI escapes.`);
    }
    if (!text || text.startsWith("/") || text.startsWith("//") || /^[A-Za-z]:\//u.test(text) || /^[a-z][a-z0-9+.-]*:/iu.test(text)) {
        throw new Error(`Import path ${JSON.stringify(value)} must be package-relative.`);
    }
    const parts = [];
    for (const part of text.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") throw new Error(`Import path ${JSON.stringify(value)} traverses outside the package.`);
        parts.push(part);
    }
    if (parts.length === 0) throw new Error("Import path cannot resolve to the package root.");
    return parts.join("/");
}

function joinPackagePath(directory, relative) {
    const base = directory ? `${directory}/` : "";
    return normalizeUrdfPath(`${base}${relative}`);
}

function elementText(document, name) {
    const nodes = document.getElementsByTagName(name);
    if (!nodes || nodes.length === 0) return "";
    return String(nodes[0].textContent ?? "").trim();
}

function indexPackageRoots(fileMap, diagnostics) {
    const roots = new Map();
    for (const [path, bytes] of fileMap) {
        if (path !== "package.xml" && !path.endsWith("/package.xml")) continue;
        const directory = path === "package.xml" ? "" : path.slice(0, -"/package.xml".length);
        try {
            const { document } = parseUrdfXml(bytes);
            const name = elementText(document, "name");
            if (!name) {
                diagnostics.push(urdfIssue("vehicle.urdf.package-name", path, `Package manifest "${path}" has no name.`));
                continue;
            }
            if (roots.has(name) && roots.get(name) !== directory) {
                diagnostics.push(urdfIssue(
                    "vehicle.urdf.ambiguous-path",
                    path,
                    `Package name "${name}" maps to both "${roots.get(name)}" and "${directory}".`,
                ));
                continue;
            }
            roots.set(name, directory);
        } catch (error) {
            diagnostics.push(...urdfXmlIssues(error).map((entry) => ({ ...entry, path })));
        }
    }
    return roots;
}

function topLevelDirectory(fileMap, name) {
    const prefix = `${name}/`;
    for (const path of fileMap.keys()) {
        if (path === name || path.startsWith(prefix)) return name;
    }
    return null;
}

/**
 * Normalize a selected local package.
 * `packageRoots` maps a ROS package name to the directory that contains its `package.xml`.
 */
export function readUrdfPackage({ entryPath, files, source } = {}) {
    const diagnostics = [];
    const fileMap = new Map();
    for (const file of files ?? []) {
        let path;
        try {
            path = normalizeUrdfPath(file?.path);
        } catch (error) {
            diagnostics.push(urdfIssue("vehicle.urdf.package-escape", String(file?.path ?? ""), error.message));
            continue;
        }
        if (fileMap.has(path)) {
            diagnostics.push(urdfIssue("vehicle.urdf.ambiguous-path", path, `Selected package contains ambiguous path "${path}".`));
            continue;
        }
        try {
            fileMap.set(path, bytesOf(file?.bytes));
        } catch (error) {
            diagnostics.push(urdfIssue("vehicle.urdf.parse", path, error.message));
        }
    }
    let entry = "";
    try {
        entry = normalizeUrdfPath(entryPath);
    } catch (error) {
        diagnostics.push(urdfIssue("vehicle.urdf.package-escape", String(entryPath ?? ""), error.message));
    }
    if (entry && !fileMap.has(entry)) {
        diagnostics.push(urdfIssue("vehicle.urdf.missing-entry", entry, `Entry "${entry}" is not among the selected files.`));
    }
    const packageRoots = indexPackageRoots(fileMap, diagnostics);
    const sorted = [...fileMap.entries()]
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .map(([path, bytes]) => ({ path, bytes }));
    const kind = source?.kind === "github" ? source : { kind: "local" };
    return {
        entryPath: entry,
        files: sorted,
        source: kind,
        diagnostics,
        packageRoots,
        fileMap,
    };
}

function candidateRoots(pkg, name) {
    const declared = pkg.packageRoots?.has(name) ? pkg.packageRoots.get(name) : null;
    const conventional = topLevelDirectory(pkg.fileMap, name);
    if (declared == null && conventional == null) return [];
    if (declared == null) return [conventional];
    if (conventional == null || conventional === declared) return [declared];
    return [declared, conventional];
}

/**
 * Resolve a visual or mesh URI against the selected package.
 * `package://` stays inside the selected set. Other URL schemes are rejected.
 */
export function resolveUrdfResource(pkg, fromPath, uri) {
    const raw = String(uri ?? "").trim();
    if (!raw) return { error: urdfIssue("vehicle.urdf.missing-mesh", fromPath, "A mesh filename is required.") };
    if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) && !raw.toLowerCase().startsWith("package://")) {
        return { error: urdfIssue("vehicle.urdf.external-uri", raw, `External URI ${JSON.stringify(raw)} is not fetched.`) };
    }
    if (raw.toLowerCase().startsWith("package://")) {
        const body = raw.slice("package://".length);
        const slash = body.indexOf("/");
        if (slash <= 0) {
            return { error: urdfIssue("vehicle.urdf.missing-mesh", raw, `Package URI ${JSON.stringify(raw)} has no resource path.`) };
        }
        const name = body.slice(0, slash);
        const relative = body.slice(slash + 1);
        const roots = candidateRoots(pkg, name);
        if (roots.length === 0) {
            return { error: urdfIssue("vehicle.urdf.missing-mesh", raw, `Package "${name}" is not in the selected set.`) };
        }
        if (roots.length > 1) {
            return { error: urdfIssue("vehicle.urdf.ambiguous-path", raw, `Package "${name}" matches more than one directory.`) };
        }
        let resolved;
        try {
            resolved = joinPackagePath(roots[0], relative);
        } catch (error) {
            return { error: urdfIssue("vehicle.urdf.package-escape", raw, error.message) };
        }
        if (!pkg.fileMap.has(resolved)) {
            return { error: urdfIssue("vehicle.urdf.missing-mesh", resolved, `Mesh "${resolved}" was not selected.`) };
        }
        return { path: resolved };
    }
    const directory = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
    let resolved;
    try {
        resolved = joinPackagePath(directory, raw);
    } catch (error) {
        return { error: urdfIssue("vehicle.urdf.package-escape", raw, error.message) };
    }
    if (!pkg.fileMap.has(resolved)) {
        return { error: urdfIssue("vehicle.urdf.missing-mesh", resolved, `Mesh "${resolved}" was not selected.`) };
    }
    return { path: resolved };
}
