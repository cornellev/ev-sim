import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileStore } from "./JsonFileStore.js";

const DEFAULT_DATA_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "data",
);
const BUILT_IN_ENVIRONMENTS = Object.freeze([
    {
        id: "igvc",
        name: "IGVC",
        templateId: "igvc",
        builtIn: true,
    },
]);

/**
 * StorageService is the single owner of the on-disk layout. Routers and other
 * callers talk to this domain API and never touch file paths directly.
 *
 * Layout under the data directory (default: `server/data/`):
 *   environments/<environmentId>.json  full Environment.toManifest() output
 *   scripts/<scriptId>.json            one human-editable file per script
 *   bindings.json                      the binding manifest
 *   settings.json                      flat key/value settings map
 *
 * Every collection is backed by JsonFileStore instances, so reads come from
 * memory and writes are atomic.
 */
export class StorageService {
    /** @param {string} [dataDir] Absolute path to the data directory. */
    constructor(dataDir = DEFAULT_DATA_DIR) {
        this.dataDir = dataDir;
        this.environmentsDir = path.join(dataDir, "environments");
        this.scriptsDir = path.join(dataDir, "scripts");
        // Cache of one JsonFileStore per file path.
        this._stores = new Map();
        this._settingsWriteChain = Promise.resolve();
        this._environmentWriteChains = new Map();
        this._deletedEnvironmentIds = new Set();
    }

    // --- Environments -------------------------------------------------------

    /** Return lightweight catalog entries for all saved and built-in worlds. */
    async listEnvironments() {
        const ids = await this._listJsonIds(this.environmentsDir);
        const saved = await Promise.all(ids.map((id) => this.getEnvironment(id)));
        const catalog = new Map(BUILT_IN_ENVIRONMENTS.map((entry) => [entry.id, entry]));

        saved.filter(Boolean).forEach((manifest) => {
            const id = manifest.environmentId;
            if (!id) return;
            const builtInEntry = BUILT_IN_ENVIRONMENTS.find((entry) => entry.id === id);
            catalog.set(id, environmentSummary(manifest, {
                builtIn: Boolean(builtInEntry),
                fallbackName: builtInEntry?.name,
            }));
        });

        return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** @returns {Promise<object|null>} the saved manifest, or null if none. */
    async getEnvironment(environmentId) {
        return this._fileStore(this._environmentPath(environmentId), null).read();
    }

    /** Persist the full environment manifest for `environmentId`. */
    putEnvironment(environmentId, manifest) {
        return this._withEnvironmentWrite(environmentId, async () => {
            if (this._deletedEnvironmentIds.has(environmentId)) {
                throw new Error(`Environment "${environmentId}" was deleted.`);
            }
            const current = await this.getEnvironment(environmentId);
            if (
                Number.isFinite(current?.clientRevision)
                && Number.isFinite(manifest?.clientRevision)
                && current.clientRevision > manifest.clientRevision
            ) {
                return current;
            }
            const normalized = normalizeEnvironmentManifest(environmentId, manifest, current);
            return this._fileStore(this._environmentPath(environmentId), null).write(normalized);
        });
    }

    /** Create a blank or template-backed environment. */
    async createEnvironment({ id, name, templateId = "blank" }) {
        safeSegment(id);
        if (BUILT_IN_ENVIRONMENTS.some((entry) => entry.id === id) || await this.getEnvironment(id)) {
            throw new Error(`Environment "${id}" already exists.`);
        }

        this._deletedEnvironmentIds.delete(id);
        return this.putEnvironment(id, {
            environmentId: id,
            name: cleanName(name, id),
            schemaVersion: 2,
            templateId: templateId === "igvc" ? "igvc" : "blank",
            roadStylePreset: templateId === "igvc" ? "igvc" : "default",
            roadsAuthored: false,
            document: emptyEnvironmentDocument(id),
        });
    }

    /** Duplicate a saved environment or a built-in template descriptor. */
    async duplicateEnvironment(sourceId, { id, name }) {
        if (BUILT_IN_ENVIRONMENTS.some((entry) => entry.id === id) || await this.getEnvironment(id)) {
            throw new Error(`Environment "${id}" already exists.`);
        }

        const source = await this.getEnvironment(sourceId);
        const builtIn = BUILT_IN_ENVIRONMENTS.find((entry) => entry.id === sourceId);
        if (!source && !builtIn) throw new Error(`Environment "${sourceId}" does not exist.`);

        const duplicate = source
            ? structuredClone(source)
            : {
                schemaVersion: 2,
                templateId: builtIn.templateId,
                roadStylePreset: builtIn.templateId === "igvc" ? "igvc" : "default",
                roadsAuthored: false,
                document: emptyEnvironmentDocument(id),
            };
        duplicate.environmentId = id;
        duplicate.name = cleanName(name, `${source?.name ?? builtIn.name} Copy`);
        duplicate.createdAt = new Date().toISOString();
        duplicate.updatedAt = duplicate.createdAt;
        if (duplicate.document) duplicate.document.environmentId = id;
        this._deletedEnvironmentIds.delete(id);
        return this.putEnvironment(id, duplicate);
    }

    /** Rename an environment without changing its stable id / filename. */
    async renameEnvironment(environmentId, name) {
        const current = await this.getEnvironment(environmentId);
        const builtIn = BUILT_IN_ENVIRONMENTS.find((entry) => entry.id === environmentId);
        if (!current && !builtIn) throw new Error(`Environment "${environmentId}" does not exist.`);

        return this.putEnvironment(environmentId, {
            ...(current ?? {
                templateId: builtIn.templateId,
                roadStylePreset: "igvc",
                roadsAuthored: false,
                document: emptyEnvironmentDocument(environmentId),
            }),
            name: cleanName(name, current?.name ?? builtIn.name),
        });
    }

    /** Delete a user environment. Built-in templates remain available. */
    async deleteEnvironment(environmentId) {
        if (BUILT_IN_ENVIRONMENTS.some((entry) => entry.id === environmentId)) {
            throw new Error(`Built-in environment "${environmentId}" cannot be deleted.`);
        }
        return this._withEnvironmentWrite(environmentId, async () => {
            this._deletedEnvironmentIds.add(environmentId);
            const filePath = this._environmentPath(environmentId);
            this._stores.get(filePath)?.invalidate();
            this._stores.delete(filePath);
            try {
                await fs.rm(filePath, { force: true });
            } catch (error) {
                this._deletedEnvironmentIds.delete(environmentId);
                throw error;
            }
            return true;
        });
    }

    // --- Scripts ------------------------------------------------------------

    /** @returns {Promise<object[]>} every stored script document. */
    async listScripts() {
        const ids = await this._listJsonIds(this.scriptsDir);
        const documents = await Promise.all(ids.map((id) => this.getScript(id)));
        return documents.filter((document) => document !== null);
    }

    /** @returns {Promise<object|null>} */
    async getScript(scriptId) {
        return this._fileStore(this._scriptPath(scriptId), null).read();
    }

    /** Persist one script document (keyed by its own `id`). */
    async putScript(document) {
        return this._fileStore(this._scriptPath(document.id), null).write(document);
    }

    /** Delete a script document. Resolves true whether or not it existed. */
    async deleteScript(scriptId) {
        const filePath = this._scriptPath(scriptId);
        this._stores.get(filePath)?.invalidate();
        this._stores.delete(filePath);
        await fs.rm(filePath, { force: true });
        return true;
    }

    // --- Bindings -----------------------------------------------------------

    /** @returns {Promise<object|null>} the binding manifest, or null. */
    getBindings() {
        return this._fileStore(path.join(this.dataDir, "bindings.json"), null).read();
    }

    putBindings(manifest) {
        return this._fileStore(path.join(this.dataDir, "bindings.json"), null).write(manifest);
    }

    // --- Settings (flat key/value map) --------------------------------------

    /** @returns {Promise<unknown|null>} the value for `key`, or null. */
    async getSetting(key) {
        const settings = await this._settingsStore().read();
        return settings?.[key] ?? null;
    }

    /** Store a single setting value, preserving the rest of the map. */
    putSetting(key, value) {
        const operation = this._settingsWriteChain
            .catch(() => {})
            .then(async () => {
                const store = this._settingsStore();
                const settings = (await store.read()) ?? {};
                settings[key] = value;
                await store.write(settings);
                return value;
            });
        this._settingsWriteChain = operation;
        return operation;
    }

    // --- Internals ----------------------------------------------------------

    _settingsStore() {
        return this._fileStore(path.join(this.dataDir, "settings.json"), {});
    }

    _withEnvironmentWrite(environmentId, operation) {
        safeSegment(environmentId);
        const previous = this._environmentWriteChains.get(environmentId) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this._environmentWriteChains.set(environmentId, current);
        current.finally(() => {
            if (this._environmentWriteChains.get(environmentId) === current) {
                this._environmentWriteChains.delete(environmentId);
            }
        }).catch(() => {});
        return current;
    }

    _environmentPath(environmentId) {
        return path.join(this.environmentsDir, `${safeSegment(environmentId)}.json`);
    }

    _scriptPath(scriptId) {
        return path.join(this.scriptsDir, `${safeSegment(scriptId)}.json`);
    }

    /** Lazily create (and cache) a JsonFileStore for a given file path. */
    _fileStore(filePath, fallback) {
        let store = this._stores.get(filePath);
        if (!store) {
            store = new JsonFileStore(filePath, { fallback });
            this._stores.set(filePath, store);
        }
        return store;
    }

    /** List the `<id>` of every `<id>.json` file in a directory. */
    async _listJsonIds(dir) {
        try {
            const entries = await fs.readdir(dir);
            return entries
                .filter((name) => name.endsWith(".json"))
                .map((name) => decodeURIComponent(name.slice(0, -".json".length)));
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    }
}

function environmentSummary(manifest, { builtIn = false, fallbackName = null } = {}) {
    return {
        id: manifest.environmentId,
        name: cleanName(manifest.name, fallbackName ?? manifest.environmentId),
        templateId: manifest.templateId ?? (manifest.environmentId === "igvc" ? "igvc" : "blank"),
        builtIn,
        updatedAt: manifest.updatedAt ?? null,
    };
}

function normalizeEnvironmentManifest(environmentId, manifest = {}, current = null) {
    const now = new Date().toISOString();
    return {
        ...manifest,
        environmentId,
        name: cleanName(manifest.name, current?.name ?? environmentId),
        schemaVersion: Math.max(2, Number(manifest.schemaVersion) || 0),
        templateId: manifest.templateId
            ?? current?.templateId
            ?? (environmentId === "igvc" ? "igvc" : "blank"),
        roadStylePreset: manifest.roadStylePreset
            ?? current?.roadStylePreset
            ?? (environmentId === "igvc" ? "igvc" : "default"),
        roadsAuthored: manifest.roadsAuthored ?? current?.roadsAuthored ?? false,
        createdAt: current?.createdAt ?? manifest.createdAt ?? now,
        updatedAt: now,
    };
}

function emptyEnvironmentDocument(environmentId) {
    return {
        environmentId,
        chunkSize: 20,
        roads: { nodes: [], edges: [] },
        buildings: [],
        features: [],
        earth: null,
        roadsAuthored: false,
        buildingsAuthored: false,
        featuresAuthored: false,
    };
}

function cleanName(value, fallback) {
    const text = String(value ?? "").trim();
    return text || String(fallback);
}

/**
 * Reject ids that could escape the data directory (path traversal) or contain
 * path separators. Ids double as filenames, so this is a security boundary.
 */
function safeSegment(value) {
    const text = String(value ?? "").trim();
    if (!text || text === "." || text === ".." || /[\\/]/.test(text)) {
        throw new Error(`Invalid storage id: ${JSON.stringify(value)}`);
    }
    return encodeURIComponent(text);
}
