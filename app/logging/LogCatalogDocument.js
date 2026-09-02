export const LOG_CATALOG_KIND = "cev-sim.log-catalog";
export const LOG_CATALOG_VERSION = 1;
export const LOG_CATALOG_FILENAME = "catalog.json";
export const UNFILED_FOLDER_ID = "__unfiled__";
export const ALL_FOLDER_ID = "__all__";

function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

function nonNegativeInt(value, fallback = 0) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? Math.max(0, Math.floor(normalized)) : fallback;
}

export function slugifyLogFolder(value, fallback = "folder") {
    const slug = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || `${fallback}-${Date.now().toString(36)}`;
}

export function normalizeLogFolderId(value) {
    if (value == null) return null;
    const normalized = String(value).trim();
    if (!normalized || normalized === UNFILED_FOLDER_ID || normalized === ALL_FOLDER_ID) return null;
    return normalized;
}

export function createLogFolder(value = {}, index = 0) {
    const source = object(value);
    return {
        id: text(source.id, slugifyLogFolder(source.name, `folder-${index + 1}`)),
        name: text(source.name, `Folder ${index + 1}`),
    };
}

export function createLogCatalog(value = {}) {
    return normalizeLogCatalog({
        kind: LOG_CATALOG_KIND,
        version: LOG_CATALOG_VERSION,
        folders: [],
        ...value,
    });
}

export function normalizeLogCatalog(value = {}) {
    const source = object(value);
    if (source.kind !== undefined && source.kind !== LOG_CATALOG_KIND) {
        throw new Error(`Unsupported log catalog kind: ${JSON.stringify(source.kind)}.`);
    }
    if (source.version !== undefined && Number(source.version) !== LOG_CATALOG_VERSION) {
        throw new Error(`Unsupported log catalog version ${source.version}.`);
    }
    const seen = new Set();
    const catalog = {
        kind: LOG_CATALOG_KIND,
        version: LOG_CATALOG_VERSION,
        folders: (Array.isArray(source.folders) ? source.folders : []).map((folder, index) => createLogFolder(folder, index)).filter((folder) => {
            if (seen.has(folder.id) || folder.id === UNFILED_FOLDER_ID || folder.id === ALL_FOLDER_ID) return false;
            seen.add(folder.id);
            return true;
        }),
    };
    if (source.revision !== undefined) {
        catalog.revision = Math.max(0, nonNegativeInt(source.revision, 0));
    }
    if (source.definitionHash !== undefined) catalog.definitionHash = text(source.definitionHash) || null;
    if (source.createdAt !== undefined) catalog.createdAt = text(source.createdAt) || null;
    if (source.updatedAt !== undefined) catalog.updatedAt = text(source.updatedAt) || null;
    return catalog;
}

export function logCatalogDefinition(catalog) {
    const normalized = normalizeLogCatalog(catalog);
    return {
        kind: normalized.kind,
        version: normalized.version,
        folders: normalized.folders,
    };
}

export function resolveLogFolderId(folderId, folders = []) {
    const normalized = normalizeLogFolderId(folderId);
    if (!normalized) return null;
    return folders.some((folder) => folder.id === normalized) ? normalized : null;
}

export function formatLogBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatLogDuration(durationUs) {
    const totalMs = Math.max(0, Math.round((Number(durationUs) || 0) / 1000));
    const minutes = Math.floor(totalMs / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function formatLogTimestamp(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}
