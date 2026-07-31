export const SCRIPT_FOLDERS_SETTING = "scriptFolders";

function trimmedString(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    const trimmed = String(value).trim();
    return trimmed || fallback;
}

export function createScriptFolderId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return `folder-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createScriptFolder(partial = {}) {
    return {
        id: trimmedString(partial.id, createScriptFolderId()),
        name: trimmedString(partial.name, "Untitled folder")
    };
}

export function normalizeScriptFolders(folders) {
    const seen = new Set();
    const normalized = [];

    for (const folder of Array.isArray(folders) ? folders : []) {
        const next = createScriptFolder(folder);
        if (seen.has(next.id)) continue;
        seen.add(next.id);
        normalized.push(next);
    }

    return normalized;
}
