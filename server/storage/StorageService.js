import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { JsonFileStore } from "./JsonFileStore.js";
import {
    RUN_BUNDLE_KIND,
    RUN_BUNDLE_VERSION,
    RUN_MANIFEST_KIND,
    RUN_MANIFEST_VERSION,
    canonicalStringify,
    createDefaultRunManifest,
    normalizeRunManifest,
    stripRunMetadata,
    validateRunManifest,
} from "../../app/simulation/RunManifest.js";
import {
    VEHICLE_BUNDLE_KIND,
    VEHICLE_BUNDLE_VERSION,
    normalizeVehicleManifest,
    validateVehicleManifest,
} from "../../app/vehicles/VehicleManifest.js";
import {
    BINDING_SCOPES,
    createBindingManifest,
    normalizeBindingManifest,
} from "../../app/scripting/bindings/BindingDocument.js";

const LEGACY_BINDINGS_SETTING = "bindings:manifest";

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
 *   run-manifests/<manifestId>.json    authored simulation run manifests
 *   vehicles/<vehicleId>.json          authored vehicle manifests
 *   vehicle-assets/<vehicleId>/<file>  binary model assets (glb/gltf)
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
        this.runManifestsDir = path.join(dataDir, "run-manifests");
        this.vehiclesDir = path.join(dataDir, "vehicles");
        this.vehicleAssetsDir = path.join(dataDir, "vehicle-assets");
        // Cache of one JsonFileStore per file path.
        this._stores = new Map();
        this._settingsWriteChain = Promise.resolve();
        this._environmentWriteChains = new Map();
        this._deletedEnvironmentIds = new Set();
        this._runManifestWriteChains = new Map();
        this._vehicleWriteChains = new Map();
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
    async getBindings() {
        const store = this._fileStore(path.join(this.dataDir, "bindings.json"), null);
        const canonical = await store.read();
        if (canonical) {
            const normalized = normalizeBindingManifest(canonical);
            if (canonical.version !== normalized.version) await store.write(normalized);
            return normalized;
        }

        const legacy = await this.getSetting(LEGACY_BINDINGS_SETTING);
        const migrated = legacy ? normalizeBindingManifest(legacy) : createBindingManifest();
        if (legacy) await store.write(migrated);
        return migrated;
    }

    putBindings(manifest) {
        return this._fileStore(path.join(this.dataDir, "bindings.json"), null)
            .write(normalizeBindingManifest(manifest));
    }

    // --- Simulation run manifests -----------------------------------------

    async listRunManifests() {
        const ids = await this._listJsonIds(this.runManifestsDir);
        const stored = (await Promise.all(ids.map((id) => this.getRunManifest(id)))).filter(Boolean);
        if (stored.length === 0) {
            const created = await this.createRunManifest(createDefaultRunManifest());
            return [runManifestSummary(created)];
        }
        return stored.map(runManifestSummary).sort((a, b) => a.name.localeCompare(b.name));
    }

    getRunManifest(manifestId) {
        return this._fileStore(this._runManifestPath(manifestId), null).read();
    }

    async createRunManifest(input = {}) {
        const validation = validateRunManifest(input.manifest ?? input);
        if (!validation.ok) throw validationError(validation.issues);
        const id = safeSegment(validation.manifest.id);
        if (await this.getRunManifest(id)) throw new Error(`Run manifest "${id}" already exists.`);
        return this._writeRunManifest(id, validation.manifest, { expectedRevision: 0, create: true });
    }

    async putRunManifest(manifestId, input = {}) {
        const manifest = input.manifest ?? input;
        const expectedRevision = input.expectedRevision ?? manifest.revision;
        const validation = validateRunManifest({ ...manifest, id: manifestId });
        if (!validation.ok) throw validationError(validation.issues);
        return this._writeRunManifest(manifestId, validation.manifest, { expectedRevision });
    }

    async duplicateRunManifest(sourceId, input = {}) {
        const source = await this.getRunManifest(sourceId);
        if (!source) throw new Error(`Run manifest "${sourceId}" does not exist.`);
        const duplicate = normalizeRunManifest({
            ...source,
            id: input.id,
            name: input.name || `${source.name} Copy`,
        });
        return this.createRunManifest(duplicate);
    }

    async deleteRunManifest(manifestId) {
        const filePath = this._runManifestPath(manifestId);
        this._stores.get(filePath)?.invalidate();
        this._stores.delete(filePath);
        await fs.rm(filePath, { force: true });
        return true;
    }

    async validateRunManifest(manifestId, input = null) {
        const source = input?.manifest ?? (input?.kind ? input : null) ?? await this.getRunManifest(manifestId);
        if (!source) throw new Error(`Run manifest "${manifestId}" does not exist.`);
        const validation = validateRunManifest(source);
        const dependencyIssues = validation.ok
            ? await this._validateRunDependencies(validation.manifest)
            : [];
        const issues = [...validation.issues, ...dependencyIssues];
        return { ok: issues.length === 0, manifest: validation.manifest, issues };
    }

    async resolveRunManifest(manifestId, input = null) {
        const source = input?.manifest ?? (input?.kind ? input : null) ?? await this.getRunManifest(manifestId);
        if (!source) throw new Error(`Run manifest "${manifestId}" does not exist.`);
        const validation = validateRunManifest(source);
        if (!validation.ok) throw validationError(validation.issues);
        const manifest = validation.manifest;
        const environment = await this._resolveEnvironment(manifest.environment.id);
        const environmentHash = semanticHash(environment);
        if (manifest.environment.expectedHash && manifest.environment.expectedHash !== environmentHash) {
            throw new Error(`Environment "${manifest.environment.id}" changed: expected ${manifest.environment.expectedHash}, received ${environmentHash}.`);
        }

        const allBindings = await this.getBindings();
        const explicitBindingIds = new Set(manifest.scripts.bindingIds);
        const selectedBindings = manifest.scripts.embeddedBindings.length > 0
            ? manifest.scripts.embeddedBindings
            : (allBindings?.bindings || []).filter((binding) => (
                binding.scope === BINDING_SCOPES.GLOBAL || explicitBindingIds.has(binding.id)
            ));
        selectedBindings.sort((left, right) => String(left.id).localeCompare(String(right.id)));

        const artifactReferences = new Map(
            manifest.scripts.artifacts.map((reference) => [reference.scriptId, reference]),
        );
        for (const binding of selectedBindings) {
            if (binding.scriptId && !artifactReferences.has(binding.scriptId)) {
                artifactReferences.set(binding.scriptId, { scriptId: binding.scriptId, expectedHash: null });
            }
        }

        const scripts = [];
        for (const reference of [...artifactReferences.values()]
            .sort((left, right) => left.scriptId.localeCompare(right.scriptId))) {
            const document = await this.getScript(reference.scriptId);
            if (!document) throw new Error(`Script "${reference.scriptId}" does not exist.`);
            const artifact = document.latestValidArtifact ?? document.artifact ?? document;
            const hash = semanticHash(artifact);
            if (reference.expectedHash && reference.expectedHash !== hash) {
                throw new Error(`Script "${reference.scriptId}" changed: expected ${reference.expectedHash}, received ${hash}.`);
            }
            scripts.push({ scriptId: reference.scriptId, hash, artifact });
        }

        const wallTimer = selectedBindings.find((binding) => binding.trigger?.kind === "timer");
        if (wallTimer) {
            throw new Error(`Binding "${wallTimer.id}" uses a wall-clock timer; deterministic runs require simulation-timer or fixed-update triggers.`);
        }
        const resolvedScriptIds = new Set(scripts.map((entry) => entry.scriptId));
        const missingScriptReference = selectedBindings.find((binding) => binding.scriptId && !resolvedScriptIds.has(binding.scriptId));
        if (missingScriptReference) {
            throw new Error(`Binding "${missingScriptReference.id}" references script "${missingScriptReference.scriptId}" without an exact manifest artifact reference.`);
        }
        const bindingsHash = semanticHash(selectedBindings);
        if (manifest.scripts.expectedBindingsHash && manifest.scripts.expectedBindingsHash !== bindingsHash) {
            throw new Error(`Script bindings changed: expected ${manifest.scripts.expectedBindingsHash}, received ${bindingsHash}.`);
        }

        const definitionHash = semanticHash(manifest);
        const resolved = {
            kind: RUN_MANIFEST_KIND,
            version: RUN_MANIFEST_VERSION,
            manifest,
            definitionHash,
            environment: { hash: environmentHash, manifest: environment },
            scripts,
            bindings: { hash: bindingsHash, entries: selectedBindings },
            schemas: standardRunSchemas(),
            dependencyHashes: {
                environment: environmentHash,
                scripts: Object.fromEntries(scripts.map((entry) => [entry.scriptId, entry.hash])),
                bindings: bindingsHash,
            },
        };
        resolved.resolvedHash = semanticHash(resolved);
        return resolved;
    }

    async exportRunManifest(manifestId) {
        const resolved = await this.resolveRunManifest(manifestId);
        return {
            kind: RUN_BUNDLE_KIND,
            version: RUN_BUNDLE_VERSION,
            exportedAt: new Date().toISOString(),
            manifest: resolved.manifest,
            resolved,
            resolvedHash: resolved.resolvedHash,
        };
    }

    async importRunBundle(bundle = {}) {
        if (bundle.kind !== RUN_BUNDLE_KIND || Number(bundle.version) !== RUN_BUNDLE_VERSION) {
            throw new Error(`Unsupported run bundle; expected ${RUN_BUNDLE_KIND} version ${RUN_BUNDLE_VERSION}.`);
        }
        if (!bundle.resolved || semanticHash(bundle.resolved) !== bundle.resolvedHash) {
            throw new Error("Run bundle resolved hash is invalid.");
        }
        const incoming = normalizeRunManifest(bundle.manifest);
        const importedEnvironment = bundle.resolved.environment?.manifest;
        if (importedEnvironment) {
            const requestedId = incoming.environment.id;
            const existing = await this.getEnvironment(requestedId);
            if (!existing && requestedId !== "igvc") {
                await this.putEnvironment(requestedId, importedEnvironment);
            } else if (semanticHash(existing ?? await this._resolveEnvironment(requestedId)) !== semanticHash(importedEnvironment)) {
                const importedId = `${requestedId}-${semanticHash(importedEnvironment).slice(0, 8)}`;
                if (!await this.getEnvironment(importedId)) {
                    await this.putEnvironment(importedId, { ...importedEnvironment, environmentId: importedId, name: `${importedEnvironment.name || requestedId} (Imported)` });
                }
                incoming.environment.id = importedId;
            }
            if (incoming.environment.expectedHash) {
                incoming.environment.expectedHash = semanticHash(await this._resolveEnvironment(incoming.environment.id));
            }
        }
        const scriptIdMap = new Map();
        for (const script of bundle.resolved.scripts || []) {
            let scriptId = script.scriptId;
            const existing = await this.getScript(scriptId);
            if (existing && semanticHash(existing.latestValidArtifact ?? existing.artifact ?? existing) !== script.hash) {
                scriptId = `${scriptId}-${script.hash.slice(0, 8)}`;
            }
            if (!await this.getScript(scriptId)) {
                await this.putScript({ id: scriptId, name: scriptId, latestValidArtifact: script.artifact });
            }
            scriptIdMap.set(script.scriptId, scriptId);
            const reference = incoming.scripts.artifacts.find((entry) => entry.scriptId === script.scriptId);
            if (reference) {
                reference.scriptId = scriptId;
                if (reference.expectedHash) reference.expectedHash = script.hash;
            }
        }
        const bundledBindings = bundle.resolved.bindings?.entries || [];
        if (bundledBindings.length > 0) {
            incoming.scripts.embeddedBindings = structuredClone(bundledBindings).map((binding) => ({
                ...binding,
                scriptId: scriptIdMap.get(binding.scriptId) || binding.scriptId,
            }));
            if (incoming.scripts.expectedBindingsHash) {
                incoming.scripts.expectedBindingsHash = semanticHash(incoming.scripts.embeddedBindings);
            }
        }
        const existingManifest = await this.getRunManifest(incoming.id);
        if (existingManifest) incoming.id = `${incoming.id}-${bundle.resolvedHash.slice(0, 8)}`;
        return this.createRunManifest(incoming);
    }

    // --- Vehicle manifests --------------------------------------------------

    async listVehicleManifests() {
        const ids = await this._listJsonIds(this.vehiclesDir);
        const stored = (await Promise.all(ids.map((id) => this.getVehicleManifest(id)))).filter(Boolean);
        return stored.map(vehicleManifestSummary).sort((a, b) => a.name.localeCompare(b.name));
    }

    getVehicleManifest(vehicleId) {
        return this._fileStore(this._vehiclePath(vehicleId), null).read();
    }

    async createVehicleManifest(input = {}) {
        const validation = validateVehicleManifest(input.manifest ?? input);
        if (!validation.ok) throw vehicleValidationError(validation.issues);
        const id = safeSegment(validation.manifest.id);
        if (await this.getVehicleManifest(id)) throw new Error(`Vehicle "${id}" already exists.`);
        return this._writeVehicleManifest(id, validation.manifest, { expectedRevision: 0, create: true });
    }

    async putVehicleManifest(vehicleId, input = {}) {
        const manifest = input.manifest ?? input;
        const expectedRevision = input.expectedRevision ?? manifest.revision;
        const validation = validateVehicleManifest({ ...manifest, id: vehicleId });
        if (!validation.ok) throw vehicleValidationError(validation.issues);
        return this._writeVehicleManifest(vehicleId, validation.manifest, { expectedRevision });
    }

    async duplicateVehicleManifest(sourceId, input = {}) {
        const source = await this.getVehicleManifest(sourceId);
        if (!source) throw new Error(`Vehicle "${sourceId}" does not exist.`);
        const duplicate = normalizeVehicleManifest({
            ...source,
            id: input.id,
            name: input.name || `${source.name} Copy`,
        });
        const created = await this.createVehicleManifest(duplicate);
        for (const fileName of await this.listVehicleAssets(sourceId)) {
            await this.putVehicleAsset(created.id, fileName, await this.readVehicleAsset(sourceId, fileName));
        }
        return created;
    }

    async deleteVehicleManifest(vehicleId) {
        const filePath = this._vehiclePath(vehicleId);
        this._stores.get(filePath)?.invalidate();
        this._stores.delete(filePath);
        await fs.rm(filePath, { force: true });
        await fs.rm(this._vehicleAssetDir(vehicleId), { recursive: true, force: true });
        return true;
    }

    async validateVehicleManifest(vehicleId, input = null) {
        const source = input?.manifest ?? (input?.kind ? input : null) ?? await this.getVehicleManifest(vehicleId);
        if (!source) throw new Error(`Vehicle "${vehicleId}" does not exist.`);
        return validateVehicleManifest(source);
    }

    async exportVehicleBundle(vehicleId) {
        const stored = await this.getVehicleManifest(vehicleId);
        if (!stored) throw new Error(`Vehicle "${vehicleId}" does not exist.`);
        const manifest = normalizeVehicleManifest(stored);
        const assets = {};
        for (const fileName of await this.listVehicleAssets(vehicleId)) {
            assets[fileName] = (await this.readVehicleAsset(vehicleId, fileName)).toString("base64");
        }
        const bundle = {
            kind: VEHICLE_BUNDLE_KIND,
            version: VEHICLE_BUNDLE_VERSION,
            exportedAt: new Date().toISOString(),
            manifest,
            assets,
        };
        bundle.bundleHash = semanticHash({ manifest: bundle.manifest, assets: bundle.assets });
        return bundle;
    }

    async importVehicleBundle(bundle = {}) {
        if (bundle.kind !== VEHICLE_BUNDLE_KIND || Number(bundle.version) !== VEHICLE_BUNDLE_VERSION) {
            throw new Error(`Unsupported vehicle bundle; expected ${VEHICLE_BUNDLE_KIND} version ${VEHICLE_BUNDLE_VERSION}.`);
        }
        const assets = bundle.assets && typeof bundle.assets === "object" ? bundle.assets : {};
        if (bundle.bundleHash && semanticHash({ manifest: bundle.manifest, assets }) !== bundle.bundleHash) {
            throw new Error("Vehicle bundle hash is invalid.");
        }
        const incoming = normalizeVehicleManifest(bundle.manifest);
        if (await this.getVehicleManifest(incoming.id)) {
            const suffix = semanticHash({ manifest: incoming, assets }).slice(0, 8);
            incoming.id = `${incoming.id}-${suffix}`;
        }
        const created = await this.createVehicleManifest(incoming);
        for (const [fileName, base64] of Object.entries(assets)) {
            await this.putVehicleAsset(created.id, fileName, Buffer.from(String(base64), "base64"));
        }
        return created;
    }

    // --- Vehicle model assets (binary files next to the manifest) -----------

    async listVehicleAssets(vehicleId) {
        try {
            return await fs.readdir(this._vehicleAssetDir(vehicleId));
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    }

    async putVehicleAsset(vehicleId, fileName, buffer) {
        const filePath = this._vehicleAssetPath(vehicleId, fileName);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, buffer);
        return { vehicleId, fileName, size: buffer.length };
    }

    async readVehicleAsset(vehicleId, fileName) {
        return fs.readFile(this._vehicleAssetPath(vehicleId, fileName));
    }

    async deleteVehicleAsset(vehicleId, fileName) {
        await fs.rm(this._vehicleAssetPath(vehicleId, fileName), { force: true });
        return true;
    }

    async _writeVehicleManifest(vehicleId, manifest, { expectedRevision, create = false } = {}) {
        safeSegment(vehicleId);
        const previous = this._vehicleWriteChains.get(vehicleId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await this.getVehicleManifest(vehicleId);
            const currentRevision = Number(current?.revision || 0);
            if (!create && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`Vehicle manifest revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            const now = new Date().toISOString();
            const normalized = normalizeVehicleManifest({ ...manifest, id: vehicleId });
            const stored = {
                ...normalized,
                revision: currentRevision + 1,
                definitionHash: semanticHash(normalized),
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
            };
            return this._fileStore(this._vehiclePath(vehicleId), null).write(stored);
        });
        this._vehicleWriteChains.set(vehicleId, operation);
        operation.finally(() => {
            if (this._vehicleWriteChains.get(vehicleId) === operation) this._vehicleWriteChains.delete(vehicleId);
        }).catch(() => {});
        return operation;
    }

    _vehiclePath(vehicleId) {
        return path.join(this.vehiclesDir, `${safeSegment(vehicleId)}.json`);
    }

    _vehicleAssetDir(vehicleId) {
        return path.join(this.vehicleAssetsDir, safeSegment(vehicleId));
    }

    _vehicleAssetPath(vehicleId, fileName) {
        return path.join(this._vehicleAssetDir(vehicleId), safeSegment(fileName));
    }

    async _writeRunManifest(manifestId, manifest, { expectedRevision, create = false } = {}) {
        safeSegment(manifestId);
        const previous = this._runManifestWriteChains.get(manifestId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await this.getRunManifest(manifestId);
            const currentRevision = Number(current?.revision || 0);
            if (!create && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`Run manifest revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            const now = new Date().toISOString();
            const normalized = normalizeRunManifest({ ...manifest, id: manifestId });
            const stored = {
                ...normalized,
                revision: currentRevision + 1,
                definitionHash: semanticHash(normalized),
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
            };
            return this._fileStore(this._runManifestPath(manifestId), null).write(stored);
        });
        this._runManifestWriteChains.set(manifestId, operation);
        operation.finally(() => {
            if (this._runManifestWriteChains.get(manifestId) === operation) this._runManifestWriteChains.delete(manifestId);
        }).catch(() => {});
        return operation;
    }

    async _validateRunDependencies(manifest) {
        try {
            await this.resolveRunManifest(manifest.id, manifest);
            return [];
        } catch (error) {
            return [{ path: "dependencies", message: error.message }];
        }
    }

    async _resolveEnvironment(environmentId) {
        const stored = await this.getEnvironment(environmentId);
        if (stored) return stored;
        if (environmentId === "igvc") {
            return {
                environmentId: "igvc",
                name: "IGVC",
                schemaVersion: 2,
                templateId: "igvc",
                roadStylePreset: "igvc",
                roadsAuthored: false,
            };
        }
        throw new Error(`Environment "${environmentId}" does not exist.`);
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

    _runManifestPath(manifestId) {
        return path.join(this.runManifestsDir, `${safeSegment(manifestId)}.json`);
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

function semanticHash(value) {
    return createHash("sha256").update(canonicalStringify(stripRunMetadata(value))).digest("hex");
}

function validationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("; ");
    return new Error(`Run manifest validation failed: ${detail}`);
}

function vehicleValidationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("; ");
    return new Error(`Vehicle manifest validation failed: ${detail}`);
}

function vehicleManifestSummary(manifest) {
    return {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        revision: manifest.revision,
        definitionHash: manifest.definitionHash,
        modelAsset: manifest.model?.asset ?? null,
        updatedAt: manifest.updatedAt,
    };
}

function runManifestSummary(manifest) {
    return {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        revision: manifest.revision,
        definitionHash: manifest.definitionHash,
        environmentId: manifest.environment?.id,
        updatedAt: manifest.updatedAt,
    };
}

function standardRunSchemas() {
    return {
        "builtin_interfaces/Time": "int32 sec\nuint32 nanosec\n",
        "std_msgs/Header": "builtin_interfaces/Time stamp\nstring frame_id\n",
        "sensor_msgs/Image": "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n",
        "sensor_msgs/CameraInfo": "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\n",
        "sensor_msgs/PointField": "uint8 INT8=1\nuint8 UINT8=2\nuint8 INT16=3\nuint8 UINT16=4\nuint8 INT32=5\nuint8 UINT32=6\nuint8 FLOAT32=7\nuint8 FLOAT64=8\nstring name\nuint32 offset\nuint8 datatype\nuint32 count\n",
        "sensor_msgs/PointCloud2": "std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n",
        "rosgraph_msgs/Clock": "builtin_interfaces/Time clock\n",
    };
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
