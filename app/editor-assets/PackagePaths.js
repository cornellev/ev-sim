/** Package-relative path rules shared by glTF and mesh import. */

export function normalizedSelectedPath(value) {
    let text = String(value ?? "").replaceAll("\\", "/");
    try { text = decodeURIComponent(text); } catch { throw new Error(`Import path ${JSON.stringify(value)} has invalid URI escapes.`); }
    if (!text || text.startsWith("/") || /^[A-Za-z]:\//.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text)) throw new Error(`Import path ${JSON.stringify(value)} must be package-relative.`);
    const parts = [];
    for (const part of text.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (parts.length === 0) throw new Error(`Import path ${JSON.stringify(value)} traverses outside the package.`);
            parts.pop();
        } else parts.push(part);
    }
    if (parts.length === 0) throw new Error("Import path cannot resolve to the package root.");
    return parts.join("/");
}

export function resolveDependency(entryPath, uri) {
    const raw = String(uri ?? "");
    if (raw.startsWith("data:")) return null;
    if (!raw || raw.startsWith("/") || raw.startsWith("\\") || raw.startsWith("//") || /^[A-Za-z]:[\\/]/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        throw new Error(`External GLTF URI ${JSON.stringify(raw)} is not a selected package path.`);
    }
    const base = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/") + 1) : "";
    return normalizedSelectedPath(`${base}${raw}`);
}
