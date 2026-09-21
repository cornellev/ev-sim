import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_PLUGINS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins");

export function localPluginsRoot() {
    return LOCAL_PLUGINS_ROOT;
}

async function existingFile(candidate) {
    try {
        const stat = await fs.lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        return candidate;
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function relativeDirectory(root, documentPath) {
    return path.relative(root, path.dirname(documentPath)).split(path.sep).join("/");
}

/**
 * Read plugin documents from the repo-root `plugins/` folder only.
 * A direct child contributes `plugin.json`, or `package/plugin.json` when
 * the kit keeps the packed package one level down. Nothing else is scanned.
 *
 * @param {string} [root]
 * @returns {Promise<Array<{ id: string, version: string, directory: string, document: object|null, error?: string }>>}
 */
export async function listLocalPlugins(root = LOCAL_PLUGINS_ROOT) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }

    const rows = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(root, entry.name);
        const documentPath = await existingFile(path.join(child, "plugin.json"))
            ?? await existingFile(path.join(child, "package", "plugin.json"));
        if (!documentPath) continue;
        const directory = relativeDirectory(root, documentPath);
        try {
            const document = JSON.parse(await fs.readFile(documentPath, "utf8"));
            if (!document || typeof document !== "object" || Array.isArray(document)) {
                rows.push({
                    id: entry.name,
                    version: "",
                    directory,
                    document: null,
                    error: "plugin.json must be an object.",
                });
                continue;
            }
            rows.push({
                id: typeof document.id === "string" && document.id ? document.id : entry.name,
                version: typeof document.version === "string" ? document.version : "",
                directory,
                document,
            });
        } catch (error) {
            rows.push({
                id: entry.name,
                version: "",
                directory,
                document: null,
                error: error instanceof SyntaxError ? "plugin.json is not valid JSON." : error.message,
            });
        }
    }

    rows.sort((left, right) => left.id.localeCompare(right.id)
        || left.version.localeCompare(right.version)
        || left.directory.localeCompare(right.directory));
    return rows;
}
