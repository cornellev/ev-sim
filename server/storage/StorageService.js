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
import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import { createBuiltInIGVCEnvironmentManifest } from "../../app/3d/igvc/IGVCEnvironmentDocument.js";
import {
    BINDING_SCOPES,
    createBindingManifest,
    normalizeBindingManifest,
} from "../../app/scripting/bindings/BindingDocument.js";
import {
    createDefaultScenario,
    createScenarioCatalog,
    normalizeScenario,
    normalizeScenarioCatalog,
    stripScenarioMetadata,
    validateScalarParameterTarget,
    validateScenario,
} from "../../app/scenarios/ScenarioDocument.js";
import {
    createDefaultExperimentSuite,
    experimentCaseKey,
    normalizeExperimentSuite,
    planExperimentCases,
    validateExperimentSuite,
} from "../../app/experiments/ExperimentSuite.js";
import {
    createExperimentResult as createExperimentResultDocument,
    normalizeExperimentResult,
    validateExperimentResult,
} from "../../app/experiments/ExperimentResult.js";
import {
    createExperimentBaseline as createExperimentBaselineDocument,
    normalizeExperimentBaseline,
    validateExperimentBaseline,
} from "../../app/experiments/BaselineComparison.js";
import {
    hashEnvironmentRoadNetwork,
    validateRouteVerification,
} from "../../app/scenarios/route/index.js";
import {
    SCENARIO_SCRIPT_CONTRACTS,
    validateScriptContract,
} from "../../app/scenarios/ScriptContracts.js";

const LEGACY_BINDINGS_SETTING = "bindings:manifest";

const DEFAULT_DATA_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "data",
);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const BUILT_IN_ENVIRONMENTS = Object.freeze([
    {
        id: "igvc",
        name: "IGVC",
        templateId: "igvc",
        builtIn: true,
    },
]);

function publicAssetFilePath(assetUrl) {
    const pathname = decodeURIComponent(String(assetUrl).split(/[?#]/, 1)[0]);
    const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
        throw new Error(`Public vehicle asset path "${assetUrl}" escapes the public directory.`);
    }
    return filePath;
}

async function hashPublicVehicleAssets(manifest) {
    const modelUrl = String(manifest?.model?.asset ?? "").trim();
    if (!modelUrl.startsWith("/") || modelUrl.startsWith("/api/")) return {};

    const urls = new Set([modelUrl.split(/[?#]/, 1)[0]]);
    const modelBytes = await fs.readFile(publicAssetFilePath(modelUrl));
    if (modelUrl.toLowerCase().split(/[?#]/, 1)[0].endsWith(".gltf")) {
        let gltf;
        try {
            gltf = JSON.parse(modelBytes.toString("utf8"));
        } catch (error) {
            throw new Error(`Public vehicle model "${modelUrl}" is not valid glTF JSON: ${error.message}`);
        }
        const modelDirectory = path.posix.dirname(modelUrl.split(/[?#]/, 1)[0]);
        for (const collection of [gltf.buffers, gltf.images]) {
            for (const entry of Array.isArray(collection) ? collection : []) {
                const uri = String(entry?.uri ?? "").trim();
                if (!uri || /^(?:data:|blob:|https?:)/i.test(uri)) continue;
                urls.add(uri.startsWith("/") ? uri : path.posix.normalize(path.posix.join(modelDirectory, uri)));
            }
        }
    }

    const hashes = {};
    for (const assetUrl of [...urls].sort()) {
        let bytes;
        try {
            bytes = assetUrl === modelUrl.split(/[?#]/, 1)[0]
                ? modelBytes
                : await fs.readFile(publicAssetFilePath(assetUrl));
        } catch (error) {
            if (error.code === "ENOENT") {
                throw new Error(`Vehicle "${manifest.id}" is missing public model asset "${assetUrl}".`);
            }
            throw error;
        }
        hashes[assetUrl] = createHash("sha256").update(bytes).digest("hex");
    }
    return hashes;
}

/**
 * StorageService is the single owner of the on-disk layout. Routers and other
 * callers talk to this domain API and never touch file paths directly.
 *
 * Layout under the data directory (default: `server/data/`):
 *   environments/<environmentId>.json  full Environment.toManifest() output
 *   scripts/<scriptId>.json            one human-editable file per script
 *   run-manifests/<manifestId>.json    authored simulation run manifests
 *   scenarios/<scenarioId>.json        authored reusable scenarios
 *   scenario-catalog.json              ordered single-level scenario folders
 *   experiment-suites/<suiteId>.json   authored deterministic experiment matrices
 *   experiment-results/<resultId>.json resumable case execution records
 *   experiment-baselines/<baselineId>.json immutable copied comparison values
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
        this.scenariosDir = path.join(dataDir, "scenarios");
        this.scenarioCatalogPath = path.join(dataDir, "scenario-catalog.json");
        this.experimentSuitesDir = path.join(dataDir, "experiment-suites");
        this.experimentResultsDir = path.join(dataDir, "experiment-results");
        this.experimentBaselinesDir = path.join(dataDir, "experiment-baselines");
        this.vehiclesDir = path.join(dataDir, "vehicles");
        this.vehicleAssetsDir = path.join(dataDir, "vehicle-assets");
        // Cache of one JsonFileStore per file path.
        this._stores = new Map();
        this._settingsWriteChain = Promise.resolve();
        this._environmentWriteChains = new Map();
        this._deletedEnvironmentIds = new Set();
        this._runManifestWriteChains = new Map();
        this._scenarioWriteChains = new Map();
        this._scenarioCatalogWriteChain = Promise.resolve();
        this._experimentSuiteWriteChains = new Map();
        this._experimentResultWriteChains = new Map();
        this._experimentBaselineWriteChains = new Map();
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
        const stored = await this._fileStore(this._environmentPath(environmentId), null).read();
        if (stored) return stored;
        return environmentId === "igvc" ? createBuiltInIGVCEnvironmentManifest() : null;
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

    /** Move a user environment to a new stable id / filename. */
    async changeEnvironmentId(environmentId, nextEnvironmentId) {
        const currentId = String(environmentId ?? "").trim();
        const nextId = validateEnvironmentId(nextEnvironmentId);
        safeSegment(currentId);
        if (currentId === nextId) {
            const current = await this.getEnvironment(currentId);
            if (!current) throw new Error(`Environment "${currentId}" does not exist.`);
            return current;
        }
        if (BUILT_IN_ENVIRONMENTS.some((entry) => entry.id === currentId)) {
            throw new Error(`Built-in environment "${currentId}" cannot change its id.`);
        }
        if (BUILT_IN_ENVIRONMENTS.some((entry) => entry.id === nextId)) {
            throw new Error(`Environment "${nextId}" already exists.`);
        }

        const ids = [currentId, nextId].sort();
        return this._withEnvironmentWrite(ids[0], () => (
            this._withEnvironmentWrite(ids[1], async () => {
                const current = await this.getEnvironment(currentId);
                if (!current) throw new Error(`Environment "${currentId}" does not exist.`);
                if (await this.getEnvironment(nextId)) {
                    throw new Error(`Environment "${nextId}" already exists.`);
                }

                const moved = normalizeEnvironmentManifest(nextId, {
                    ...current,
                    document: current.document
                        ? { ...current.document, environmentId: nextId }
                        : current.document,
                }, current);
                const currentPath = this._environmentPath(currentId);
                const nextPath = this._environmentPath(nextId);
                const nextStore = this._fileStore(nextPath, null);

                this._deletedEnvironmentIds.delete(nextId);
                await nextStore.write(moved);
                try {
                    await fs.rm(currentPath);
                } catch (error) {
                    await fs.rm(nextPath, { force: true });
                    nextStore.invalidate();
                    this._stores.delete(nextPath);
                    throw error;
                }

                this._stores.get(currentPath)?.invalidate();
                this._stores.delete(currentPath);
                this._deletedEnvironmentIds.add(currentId);
                return moved;
            })
        ));
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

    // --- Scenarios ---------------------------------------------------------

    async listScenarios() {
        const ids = await this._listJsonIds(this.scenariosDir);
        const scenarios = (await Promise.all(ids.map((id) => this.getScenario(id)))).filter(Boolean);
        return scenarios.map(scenarioSummary).sort((left, right) => left.name.localeCompare(right.name));
    }

    getScenario(scenarioId) {
        return this._fileStore(this._scenarioPath(scenarioId), null).read();
    }

    async createScenario(input = {}) {
        const requested = input.scenario ?? input;
        const scenario = normalizeScenario(Object.keys(requested).length > 0
            ? requested
            : createDefaultScenario(), { allowMissingKind: true });
        const id = safeSegment(scenario.id);
        if (await this.getScenario(id)) throw new Error(`Scenario "${id}" already exists.`);
        return this._writeScenario(id, scenario, { expectedRevision: 0, create: true });
    }

    async putScenario(scenarioId, input = {}) {
        const requested = input.scenario ?? input;
        const expectedRevision = input.expectedRevision ?? requested.revision;
        const scenario = normalizeScenario({ ...requested, id: scenarioId }, { allowMissingKind: true });
        return this._writeScenario(scenarioId, scenario, { expectedRevision });
    }

    async duplicateScenario(sourceId, input = {}) {
        const source = await this.getScenario(sourceId);
        if (!source) throw new Error(`Scenario "${sourceId}" does not exist.`);
        const id = String(input.id || `${sourceId}-copy`).trim();
        const duplicate = normalizeScenario({
            ...stripScenarioMetadata(source),
            id,
            name: input.name || `${source.name} Copy`,
            folderId: input.folderId ?? source.folderId,
        }, { allowMissingKind: true });
        return this.createScenario(duplicate);
    }

    deleteScenario(scenarioId, expectedRevision) {
        return this._deleteRevisionedDocument({
            id: scenarioId,
            filePath: this._scenarioPath(scenarioId),
            writeChains: this._scenarioWriteChains,
            getCurrent: () => this.getScenario(scenarioId),
            expectedRevision,
            label: "Scenario",
        });
    }

    async getScenarioCatalog() {
        const store = this._fileStore(this.scenarioCatalogPath, null);
        const stored = await store.read();
        if (stored) return normalizeScenarioCatalog(stored);
        const catalog = createScenarioCatalog();
        return {
            ...catalog,
            revision: 0,
            definitionHash: semanticHash(catalog),
            createdAt: null,
            updatedAt: null,
        };
    }

    putScenarioCatalog(value = {}) {
        const requested = value.catalog ?? value;
        const expectedRevision = value.expectedRevision ?? requested.revision;
        const operation = this._scenarioCatalogWriteChain.catch(() => {}).then(async () => {
            const current = await this.getScenarioCatalog();
            const currentRevision = Number(current.revision || 0);
            if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`Scenario catalog revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            const now = new Date().toISOString();
            const normalized = normalizeScenarioCatalog(requested);
            const definition = {
                kind: normalized.kind,
                version: normalized.version,
                folders: normalized.folders,
            };
            return this._fileStore(this.scenarioCatalogPath, null).write({
                ...definition,
                revision: currentRevision + 1,
                definitionHash: semanticHash(definition),
                createdAt: current.createdAt ?? now,
                updatedAt: now,
            });
        });
        this._scenarioCatalogWriteChain = operation;
        return operation;
    }

    async validateScenario(scenarioId, input = null) {
        const source = input?.scenario ?? (input?.kind ? input : null) ?? await this.getScenario(scenarioId);
        if (!source) throw new Error(`Scenario "${scenarioId}" does not exist.`);
        const validation = validateScenario(source);
        const dependencyIssues = validation.scenario
            ? await this._validateScenarioDependencies(validation.scenario)
            : [];
        const issues = [...validation.issues, ...dependencyIssues];
        return { ok: issues.length === 0, scenario: validation.scenario, issues };
    }

    async resolveScenario(scenarioId, input = null, options = {}) {
        const source = input?.scenario ?? (input?.kind ? input : null) ?? await this.getScenario(scenarioId);
        if (!source) throw new Error(`Scenario "${scenarioId}" does not exist.`);
        const validation = validateScenario(source);
        if (!validation.ok) throw scenarioValidationError(validation.issues);

        const definitionHash = semanticHash(stripScenarioMetadata(validation.scenario));
        const expectedHash = options.expectedHash ?? input?.expectedHash ?? null;
        if (expectedHash && expectedHash !== definitionHash) {
            throw new Error(`Scenario "${scenarioId}" changed: expected ${expectedHash}, received ${definitionHash}.`);
        }

        const parameterValues = {
            ...objectValues(input?.parameterValues),
            ...objectValues(options.parameterValues),
        };
        const parameterResolution = resolveDeclaredParameters(validation.scenario.parameters, parameterValues, "scenario");
        let scenario = applyDocumentScalarParameters(
            validation.scenario,
            validation.scenario.parameters,
            parameterResolution.values,
            "scenario",
        );
        const parameterizedValidation = validateScenario(scenario);
        if (!parameterizedValidation.ok) throw scenarioValidationError(parameterizedValidation.issues);
        assertScalarParameterValuesPreserved(
            parameterizedValidation.scenario,
            validation.scenario.parameters,
            parameterResolution.values,
            "scenario",
        );
        scenario = parameterizedValidation.scenario;
        const environment = await this._resolveEnvironment(scenario.environment.id);
        const environmentHash = semanticHash(environment);
        const roadNetworkHash = hashEnvironmentRoadNetwork(environment);
        if (scenario.environment.expectedHash && scenario.environment.expectedHash !== environmentHash) {
            throw new Error(`Environment "${scenario.environment.id}" changed: expected ${scenario.environment.expectedHash}, received ${environmentHash}.`);
        }
        for (const route of scenario.routes) {
            const routeValidation = validateRouteVerification(route, environment);
            if (!routeValidation.ok) {
                throw new Error(`Route "${route.id}" must be re-verified: ${routeValidation.issues.map((issue) => issue.message).join(" ")}`);
            }
        }

        const scriptIds = collectScenarioScriptIds(scenario);
        const scripts = [];
        for (const scriptId of scriptIds) {
            const document = await this.getScript(scriptId);
            if (!document) throw new Error(`Script "${scriptId}" does not exist.`);
            const artifact = document.latestValidArtifact ?? document.artifact ?? document;
            scripts.push({ scriptId, hash: semanticHash(artifact), artifact });
        }
        const artifactsById = new Map(scripts.map((entry) => [entry.scriptId, entry.artifact]));
        for (const parameter of scenario.parameters.filter((entry) => entry.target.kind === "script-input")) {
            const artifact = artifactsById.get(parameter.target.scriptId);
            const port = artifact?.interface?.inputs?.find((entry) => entry.label === parameter.target.input);
            if (!port) {
                throw new Error(`Parameter "${parameter.id}" references missing script input "${parameter.target.input}".`);
            }
            if (port.type !== parameter.type) {
                throw new Error(`Parameter "${parameter.id}" is ${parameter.type}, but its script input is ${port.type}.`);
            }
        }
        for (const route of scenario.routes) {
            if (!route.controller.scriptId) continue;
            const artifact = artifactsById.get(route.controller.scriptId);
            if (route.controller.kind === "script-with-route"
                && !artifact?.interface?.inputs?.some((port) => port.label === "route" && port.type === "route")) {
                throw new Error(`Route controller script "${route.controller.scriptId}" requires a route: route input.`);
            }
            const outputPorts = new Map((artifact?.interface?.outputs ?? []).map((port) => [port.label, port]));
            for (const mapping of route.controller.outputs ?? []) {
                const label = mapping?.output ?? mapping?.source ?? mapping?.port ?? mapping?.label ?? mapping?.name;
                const target = mapping?.target ?? mapping?.command;
                if (!["speed", "steering"].includes(target)) continue;
                const port = outputPorts.get(label);
                if (!port) {
                    throw new Error(`Route controller script "${route.controller.scriptId}" has no mapped output "${label}".`);
                }
                if (port.type !== "float64") {
                    throw new Error(`Route controller output "${label}" must be float64 for ${target}.`);
                }
            }
        }
        for (const completion of scenario.completion.conditions.filter((entry) => entry.kind === "script")) {
            const contract = validateScriptContract(
                artifactsById.get(completion.scriptId),
                SCENARIO_SCRIPT_CONTRACTS.FINISH,
            );
            if (!contract.ok) throw new Error(`Finish script "${completion.scriptId}" has an invalid interface: ${contract.issues.join(" ")}`);
        }
        for (const outcome of scenario.expectedOutcomes.filter((entry) => entry.kind === "script")) {
            const contract = validateScriptContract(
                artifactsById.get(outcome.scriptId),
                SCENARIO_SCRIPT_CONTRACTS.EXPECTED_OUTCOME,
            );
            if (!contract.ok) throw new Error(`Expected-outcome script "${outcome.scriptId}" has an invalid interface: ${contract.issues.join(" ")}`);
        }

        const vehicles = [];
        for (const actor of scenario.actors.filter((entry) => entry.id !== "ego")) {
            vehicles.push(await this._resolveVehicleDependency(actor.id, actor.vehicleId));
        }

        const resolved = {
            kind: scenario.kind,
            version: scenario.version,
            scenario,
            definitionHash,
            environment: { hash: environmentHash, manifest: environment },
            scripts,
            vehicles,
            parameters: parameterResolution,
            dependencyHashes: {
                scenario: definitionHash,
                environment: environmentHash,
                roadNetwork: roadNetworkHash,
                scripts: Object.fromEntries(scripts.map((entry) => [entry.scriptId, entry.hash])),
                vehicles: Object.fromEntries(vehicles.map((entry) => [entry.vehicleId, entry.hash])),
                vehicleAssets: Object.fromEntries(vehicles.map((entry) => [entry.vehicleId, entry.assetHashes])),
            },
        };
        resolved.resolvedHash = semanticHash(resolved);
        return resolved;
    }

    async verifyScenarioRoute(scenarioId, input = {}) {
        const source = input.scenario ?? await this.getScenario(scenarioId);
        if (!source) throw new Error(`Scenario "${scenarioId}" does not exist.`);
        const scenario = normalizeScenario(source, { allowMissingKind: true });
        const route = scenario.routes.find((entry) => entry.id === input.routeId);
        if (!route) throw new Error(`Route "${input.routeId}" does not exist.`);
        const environment = await this._resolveEnvironment(scenario.environment.id);
        const { verifyRoute } = await import("../../app/scenarios/route/index.js");
        // Keep the environment envelope so the canonical road-network identity
        // includes the stable environment id, exactly as scenario resolution does.
        return verifyRoute(route.waypoints, environment);
    }

    // --- Experiment suites, results, and baselines ------------------------

    async listExperimentSuites() {
        const ids = await this._listJsonIds(this.experimentSuitesDir);
        const suites = (await Promise.all(ids.map((id) => this.getExperimentSuite(id)))).filter(Boolean);
        return suites.map(experimentSuiteSummary).sort((left, right) => left.name.localeCompare(right.name));
    }

    getExperimentSuite(suiteId) {
        return this._fileStore(this._experimentSuitePath(suiteId), null).read();
    }

    async createExperimentSuite(input = {}) {
        const requested = input.suite ?? input;
        const suite = normalizeExperimentSuite(Object.keys(requested).length > 0
            ? requested
            : createDefaultExperimentSuite(), { allowMissingKind: true });
        safeSegment(suite.id);
        if (await this.getExperimentSuite(suite.id)) {
            throw new Error(`Experiment suite "${suite.id}" already exists.`);
        }
        return this._writeExperimentSuite(suite.id, suite, { expectedRevision: 0, create: true });
    }

    async putExperimentSuite(suiteId, input = {}) {
        const requested = input.suite ?? input;
        const expectedRevision = input.expectedRevision ?? requested.revision;
        const suite = normalizeExperimentSuite({ ...requested, id: suiteId }, { allowMissingKind: true });
        return this._writeExperimentSuite(suiteId, suite, { expectedRevision });
    }

    async duplicateExperimentSuite(sourceId, input = {}) {
        const source = await this.getExperimentSuite(sourceId);
        if (!source) throw new Error(`Experiment suite "${sourceId}" does not exist.`);
        const id = String(input.id || `${sourceId}-copy`).trim();
        return this.createExperimentSuite({
            ...source,
            id,
            name: input.name || `${source.name} Copy`,
        });
    }

    deleteExperimentSuite(suiteId, expectedRevision) {
        return this._deleteRevisionedDocument({
            id: suiteId,
            filePath: this._experimentSuitePath(suiteId),
            writeChains: this._experimentSuiteWriteChains,
            getCurrent: () => this.getExperimentSuite(suiteId),
            expectedRevision,
            label: "Experiment suite",
        });
    }

    async validateExperimentSuite(suiteId, input = null) {
        const source = input?.suite ?? (input?.kind ? input : null) ?? await this.getExperimentSuite(suiteId);
        if (!source) throw new Error(`Experiment suite "${suiteId}" does not exist.`);
        const suite = normalizeExperimentSuite(source, { allowMissingKind: true });
        const context = await this._experimentPlanningContext(suite, { resolveDependencies: true });
        return validateExperimentSuite(suite, context);
    }

    async resolveExperimentCase(suiteId, input = {}) {
        const suite = await this.getExperimentSuite(suiteId);
        if (!suite) throw new Error(`Experiment suite "${suiteId}" does not exist.`);
        const context = await this._experimentPlanningContext(suite);
        const plan = planExperimentCases(suite, context);
        if (!plan.ok) throw experimentValidationError(plan.issues);

        const requested = input.case && typeof input.case === "object" ? input.case : input;
        const selected = requested.caseId
            ? plan.cases.find((entry) => entry.id === requested.caseId)
            : plan.cases.find((entry) => experimentCaseIdentityMatches(entry, requested));
        if (!selected) throw new Error("The requested case is not part of the suite's current deterministic expansion.");

        const scenario = context.scenarios.find((entry) => entry.id === selected.scenarioId);
        const manifest = context.manifests.find((entry) => entry.id === selected.manifestId);
        const scenarioIds = new Set((scenario?.parameters ?? scenario?.experimentParameters ?? []).map((entry) => entry.id));
        const manifestIds = new Set((manifest?.parameters ?? manifest?.experimentParameters ?? []).map((entry) => entry.id));
        const scenarioParameterValues = {};
        const manifestParameterValues = {};
        for (const [parameterId, value] of Object.entries(selected.parameters)) {
            if (scenarioIds.has(parameterId)) scenarioParameterValues[parameterId] = value;
            if (manifestIds.has(parameterId)) manifestParameterValues[parameterId] = value;
        }

        const resolvedRun = await this.resolveRunManifest(selected.manifestId, {
            scenarioId: selected.scenarioId,
            seed: selected.seed,
            scenarioParameterValues,
            manifestParameterValues,
            egoVehicleId: requested.egoVehicleId,
            sensorBindings: requested.sensorBindings,
        });
        return {
            case: selected,
            suite: {
                id: suite.id,
                revision: suite.revision,
                definitionHash: suite.definitionHash,
            },
            resolvedRun,
            resolvedHash: resolvedRun.resolvedHash,
            dependencyHashes: resolvedRun.dependencyHashes,
            realtimeWarning: resolvedRun.manifest?.clock?.pacing === "realtime"
                && resolvedRun.scenario?.scenario?.routes?.some((route) => route.controller?.kind === "external-ros"),
        };
    }

    async listExperimentResults() {
        const ids = await this._listJsonIds(this.experimentResultsDir);
        const results = (await Promise.all(ids.map((id) => this.getExperimentResult(id)))).filter(Boolean);
        return results.map(experimentResultSummary).sort((left, right) => (
            String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
        ));
    }

    getExperimentResult(resultId) {
        return this._fileStore(this._experimentResultPath(resultId), null).read();
    }

    async createExperimentResult(input = {}) {
        let requested = input.result ?? input;
        if (input.suiteId && !requested.kind) {
            const suite = await this.getExperimentSuite(input.suiteId);
            if (!suite) throw new Error(`Experiment suite "${input.suiteId}" does not exist.`);
            const context = await this._experimentPlanningContext(suite);
            const plan = planExperimentCases(suite, context);
            if (!plan.ok) throw experimentValidationError(plan.issues);
            requested = createExperimentResultDocument(suite, plan.cases, input);
        }
        const validation = validateExperimentResult(requested);
        if (!validation.ok) throw experimentResultValidationError(validation.issues);
        safeSegment(validation.result.id);
        if (await this.getExperimentResult(validation.result.id)) {
            throw new Error(`Experiment result "${validation.result.id}" already exists.`);
        }
        return this._writeExperimentResult(validation.result.id, validation.result, { expectedRevision: 0, create: true });
    }

    async putExperimentResult(resultId, input = {}) {
        const requested = input.result ?? input;
        const expectedRevision = input.expectedRevision ?? requested.revision;
        const validation = validateExperimentResult({ ...requested, id: resultId });
        if (!validation.ok) throw experimentResultValidationError(validation.issues);
        return this._writeExperimentResult(resultId, validation.result, { expectedRevision });
    }

    async validateExperimentResult(resultId, input = null) {
        const source = input?.result ?? (input?.kind ? input : null) ?? await this.getExperimentResult(resultId);
        if (!source) throw new Error(`Experiment result "${resultId}" does not exist.`);
        return validateExperimentResult(source);
    }

    deleteExperimentResult(resultId, expectedRevision) {
        return this._deleteRevisionedDocument({
            id: resultId,
            filePath: this._experimentResultPath(resultId),
            writeChains: this._experimentResultWriteChains,
            getCurrent: () => this.getExperimentResult(resultId),
            expectedRevision,
            label: "Experiment result",
        });
    }

    async listExperimentBaselines(suiteId = null) {
        const ids = await this._listJsonIds(this.experimentBaselinesDir);
        const baselines = (await Promise.all(ids.map((id) => this.getExperimentBaseline(id))))
            .filter((entry) => entry && (!suiteId || entry.suiteId === suiteId));
        return baselines.map(experimentBaselineSummary).sort((left, right) => (
            String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
        ));
    }

    getExperimentBaseline(baselineId) {
        return this._fileStore(this._experimentBaselinePath(baselineId), null).read();
    }

    async createExperimentBaseline(input = {}) {
        let requested = input.baseline ?? input;
        if (input.resultId) {
            const result = await this.getExperimentResult(input.resultId);
            if (!result) throw new Error(`Experiment result "${input.resultId}" does not exist.`);
            requested = createExperimentBaselineDocument(result, input);
        }
        const caseDependencies = Object.fromEntries((requested.cases ?? []).map((entry) => [
            entry.key ?? experimentCaseKey(entry),
            {
                resolvedHash: entry.resolvedHash ?? null,
                dependencyHashes: structuredClone(entry.dependencyHashes ?? {}),
            },
        ]));
        requested = {
            ...requested,
            provenance: {
                ...objectValues(requested.provenance),
                appVersion: requested.provenance?.appVersion
                    ?? process.env.NEXT_PUBLIC_APP_VERSION
                    ?? process.env.npm_package_version
                    ?? "0.1.0",
                gitCommit: requested.provenance?.gitCommit
                    ?? process.env.NEXT_PUBLIC_GIT_HASH
                    ?? process.env.GIT_COMMIT
                    ?? null,
                dependencies: {
                    ...objectValues(requested.provenance?.dependencies),
                    cases: caseDependencies,
                },
            },
        };
        const validation = validateExperimentBaseline(requested);
        if (!validation.ok) throw experimentBaselineValidationError(validation.issues);
        safeSegment(validation.baseline.id);
        const stored = {
            ...normalizeExperimentBaseline(validation.baseline),
            definitionHash: semanticHash(validation.baseline),
        };
        return this._writeExperimentBaseline(stored.id, stored);
    }

    async validateExperimentBaseline(baselineId, input = null) {
        const source = input?.baseline ?? (input?.kind ? input : null) ?? await this.getExperimentBaseline(baselineId);
        if (!source) throw new Error(`Experiment baseline "${baselineId}" does not exist.`);
        return validateExperimentBaseline(source);
    }

    deleteExperimentBaseline(baselineId) {
        return this._deleteRevisionedDocument({
            id: baselineId,
            filePath: this._experimentBaselinePath(baselineId),
            writeChains: this._experimentBaselineWriteChains,
            getCurrent: () => this.getExperimentBaseline(baselineId),
            expectedRevision: undefined,
            label: "Experiment baseline",
        });
    }

    async _experimentPlanningContext(suiteValue, { resolveDependencies = false } = {}) {
        const suite = normalizeExperimentSuite(suiteValue, { allowMissingKind: true });
        const scenarios = (await Promise.all(suite.scenarioIds.map((id) => this.getScenario(id)))).filter(Boolean);
        const manifests = (await Promise.all(suite.manifestIds.map((id) => this.getRunManifest(id)))).filter(Boolean);
        const compatibility = new Map();
        await Promise.all(scenarios.flatMap((scenario) => manifests.map(async (manifest) => {
            const key = `${scenario.id}\u0000${manifest.id}`;
            const egoVehicleId = manifest?.scenario?.egoVehicleId
                || manifest?.initialState?.vehicles?.find((vehicle) => vehicle.id === "ego" || vehicle.role === "ego")?.type;
            if (!egoVehicleId) {
                compatibility.set(key, "The run manifest does not assign a concrete Ego vehicle.");
                return;
            }
            if (!resolveDependencies) {
                compatibility.set(key, true);
                return;
            }
            try {
                // Resolve the default parameter vector up front so the matrix
                // reports missing assets, scripts, sensor aliases, topics, and
                // stale route/environment hashes before a queue is started.
                await this.resolveRunManifest(manifest.id, {
                    scenarioId: scenario.id,
                    egoVehicleId,
                    sensorBindings: manifest?.scenario?.sensorBindings,
                    seed: manifest.seed,
                });
                compatibility.set(key, true);
            } catch (error) {
                compatibility.set(key, error?.message || "Scenario and run manifest are incompatible.");
            }
        })));
        return {
            scenarios,
            manifests,
            isCompatible: ({ scenarioId, manifestId }) => (
                compatibility.get(`${scenarioId}\u0000${manifestId}`)
                ?? "Scenario or run manifest could not be loaded."
            ),
        };
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
        const resolutionOptions = input?.kind ? {} : objectValues(input);
        const runParameterValues = objectValues(
            resolutionOptions.manifestParameterValues ?? resolutionOptions.parameterValues,
        );
        const runParameters = resolveDeclaredParameters(validation.manifest.parameters, runParameterValues, "run manifest");
        let manifest = applyDocumentScalarParameters(
            validation.manifest,
            validation.manifest.parameters,
            runParameters.values,
            "run manifest",
        );
        const parameterizedValidation = validateRunManifest(manifest);
        if (!parameterizedValidation.ok) throw validationError(parameterizedValidation.issues);
        assertScalarParameterValuesPreserved(
            parameterizedValidation.manifest,
            validation.manifest.parameters,
            runParameters.values,
            "run manifest",
        );
        manifest = parameterizedValidation.manifest;
        if (resolutionOptions.seed !== undefined) manifest.seed = resolutionOptions.seed;

        const transientScenarioId = String(resolutionOptions.scenarioId ?? "").trim() || null;
        const selectedScenario = transientScenarioId
            ? {
                ...(manifest.scenario ?? {}),
                id: transientScenarioId,
                expectedHash: resolutionOptions.scenarioExpectedHash ?? null,
                egoVehicleId: resolutionOptions.egoVehicleId
                    ?? manifest.scenario?.egoVehicleId
                    ?? manifest.initialState.vehicles.find((entry) => entry.id === "ego")?.type
                    ?? null,
                sensorBindings: objectValues(resolutionOptions.sensorBindings ?? manifest.scenario?.sensorBindings),
                parameterValues: objectValues(resolutionOptions.scenarioParameterValues),
            }
            : manifest.scenario;
        let resolvedScenario = null;
        let resolvedVehicles = [];
        if (selectedScenario) {
            const scenarioParameterValues = {
                ...objectValues(selectedScenario.parameterValues),
                ...objectValues(resolutionOptions.scenarioParameterValues),
            };
            resolvedScenario = await this.resolveScenario(selectedScenario.id, null, {
                expectedHash: selectedScenario.expectedHash,
                parameterValues: scenarioParameterValues,
            });
            manifest = normalizeRunManifest({
                ...manifest,
                scenario: {
                    ...selectedScenario,
                    parameterValues: scenarioParameterValues,
                },
                environment: {
                    id: resolvedScenario.scenario.environment.id,
                    expectedHash: resolvedScenario.environment.hash,
                },
                initialState: {
                    ...manifest.initialState,
                    vehicles: buildScenarioInitialVehicles(
                        resolvedScenario.scenario,
                        selectedScenario.egoVehicleId,
                    ),
                },
                clock: scenarioUsesExternalController(resolvedScenario.scenario)
                    ? { ...manifest.clock, pacing: "realtime" }
                    : manifest.clock,
            }, { allowMissingKind: true });

            resolvedVehicles = [
                await this._resolveVehicleDependency("ego", selectedScenario.egoVehicleId),
                ...resolvedScenario.vehicles,
            ];
            validateScenarioSensorBindings(resolvedScenario.scenario, manifest);
        }

        const vehicleDependenciesByActor = new Map(resolvedVehicles.map((entry) => [entry.actorId, entry]));
        resolvedVehicles = await Promise.all(manifest.initialState.vehicles.map(async (vehicle) => {
            const existing = vehicleDependenciesByActor.get(vehicle.id);
            return existing?.vehicleId === vehicle.type
                ? existing
                : this._resolveVehicleDependency(vehicle.id, vehicle.type);
        }));
        const vehicleIds = new Set(manifest.initialState.vehicles.map((entry) => entry.id));
        for (const sensor of manifest.sensorRig.sensors) {
            if (!vehicleIds.has(sensor.parentId)) {
                throw new Error(`Sensor "${sensor.id}" references unknown run vehicle "${sensor.parentId}".`);
            }
        }

        const environment = resolvedScenario?.environment.manifest
            ?? await this._resolveEnvironment(manifest.environment.id);
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
        for (const script of resolvedScenario?.scripts ?? []) {
            if (!artifactReferences.has(script.scriptId)) {
                artifactReferences.set(script.scriptId, { scriptId: script.scriptId, expectedHash: script.hash });
            }
        }
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
        const resolvedArtifacts = new Map(scripts.map((entry) => [entry.scriptId, entry.artifact]));
        for (const parameter of runParameters.bindings.filter((entry) => entry.target.kind === "script-input")) {
            const artifact = resolvedArtifacts.get(parameter.target.scriptId);
            const port = artifact?.interface?.inputs?.find((entry) => entry.label === parameter.target.input);
            if (!port) {
                throw new Error(`Run parameter "${parameter.id}" references missing script input "${parameter.target.input}".`);
            }
            if (port.type !== parameter.type) {
                throw new Error(`Run parameter "${parameter.id}" is ${parameter.type}, but its script input is ${port.type}.`);
            }
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
            scenario: resolvedScenario,
            vehicles: resolvedVehicles,
            parameters: {
                manifest: runParameters,
                scenario: resolvedScenario?.parameters ?? { values: {}, bindings: [] },
            },
            schemas: standardRunSchemas(),
            dependencyHashes: {
                environment: environmentHash,
                scripts: Object.fromEntries(scripts.map((entry) => [entry.scriptId, entry.hash])),
                bindings: bindingsHash,
                ...(resolvedScenario ? { scenario: resolvedScenario.definitionHash } : {}),
                vehicles: Object.fromEntries(resolvedVehicles.map((entry) => [entry.vehicleId, entry.hash])),
                vehicleAssets: Object.fromEntries(resolvedVehicles.map((entry) => [entry.vehicleId, entry.assetHashes])),
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

    async _writeScenario(scenarioId, scenario, { expectedRevision, create = false } = {}) {
        safeSegment(scenarioId);
        const previous = this._scenarioWriteChains.get(scenarioId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await this.getScenario(scenarioId);
            const currentRevision = Number(current?.revision || 0);
            if (create && current) throw new Error(`Scenario "${scenarioId}" already exists.`);
            if (!create && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`Scenario revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            const now = new Date().toISOString();
            const normalized = normalizeScenario({ ...scenario, id: scenarioId }, { allowMissingKind: true });
            const stored = {
                ...normalized,
                revision: currentRevision + 1,
                definitionHash: semanticHash(stripScenarioMetadata(normalized)),
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
            };
            return this._fileStore(this._scenarioPath(scenarioId), null).write(stored);
        });
        this._scenarioWriteChains.set(scenarioId, operation);
        operation.finally(() => {
            if (this._scenarioWriteChains.get(scenarioId) === operation) this._scenarioWriteChains.delete(scenarioId);
        }).catch(() => {});
        return operation;
    }

    async _validateScenarioDependencies(scenario) {
        try {
            await this.resolveScenario(scenario.id, scenario);
            return [];
        } catch (error) {
            return [{ path: "dependencies", message: error.message }];
        }
    }

    async _writeExperimentSuite(suiteId, suite, { expectedRevision, create = false } = {}) {
        safeSegment(suiteId);
        const previous = this._experimentSuiteWriteChains.get(suiteId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await this.getExperimentSuite(suiteId);
            const currentRevision = Number(current?.revision || 0);
            if (create && current) throw new Error(`Experiment suite "${suiteId}" already exists.`);
            if (!create && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`Experiment suite revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            const now = new Date().toISOString();
            const normalized = normalizeExperimentSuite({ ...suite, id: suiteId }, { allowMissingKind: true });
            const stored = {
                ...normalized,
                revision: currentRevision + 1,
                definitionHash: semanticHash(normalized),
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
            };
            return this._fileStore(this._experimentSuitePath(suiteId), null).write(stored);
        });
        this._experimentSuiteWriteChains.set(suiteId, operation);
        operation.finally(() => {
            if (this._experimentSuiteWriteChains.get(suiteId) === operation) {
                this._experimentSuiteWriteChains.delete(suiteId);
            }
        }).catch(() => {});
        return operation;
    }

    async _writeExperimentResult(resultId, result, { expectedRevision, create = false } = {}) {
        safeSegment(resultId);
        const previous = this._experimentResultWriteChains.get(resultId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await this.getExperimentResult(resultId);
            const currentRevision = Number(current?.revision || 0);
            if (create && current) throw new Error(`Experiment result "${resultId}" already exists.`);
            if (!create && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`Experiment result revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            const now = new Date().toISOString();
            const normalized = normalizeExperimentResult({ ...result, id: resultId }, { allowMissingKind: true });
            const stored = {
                ...normalized,
                revision: currentRevision + 1,
                definitionHash: semanticHash(normalized),
                createdAt: normalized.createdAt ?? current?.createdAt ?? now,
                updatedAt: now,
            };
            return this._fileStore(this._experimentResultPath(resultId), null).write(stored);
        });
        this._experimentResultWriteChains.set(resultId, operation);
        operation.finally(() => {
            if (this._experimentResultWriteChains.get(resultId) === operation) {
                this._experimentResultWriteChains.delete(resultId);
            }
        }).catch(() => {});
        return operation;
    }

    async _writeExperimentBaseline(baselineId, baseline) {
        safeSegment(baselineId);
        const previous = this._experimentBaselineWriteChains.get(baselineId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            if (await this.getExperimentBaseline(baselineId)) {
                throw new Error(`Experiment baseline "${baselineId}" already exists and is immutable.`);
            }
            return this._fileStore(this._experimentBaselinePath(baselineId), null).write(baseline);
        });
        this._experimentBaselineWriteChains.set(baselineId, operation);
        operation.finally(() => {
            if (this._experimentBaselineWriteChains.get(baselineId) === operation) {
                this._experimentBaselineWriteChains.delete(baselineId);
            }
        }).catch(() => {});
        return operation;
    }

    async _deleteStoredDocument(filePath) {
        this._stores.get(filePath)?.invalidate();
        this._stores.delete(filePath);
        await fs.rm(filePath, { force: true });
        return true;
    }

    _deleteRevisionedDocument({
        id,
        filePath,
        writeChains,
        getCurrent,
        expectedRevision,
        label,
    }) {
        const previous = writeChains.get(id) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await getCurrent();
            if (!current) return false;
            const currentRevision = Number(current.revision || 0);
            if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`${label} revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            return this._deleteStoredDocument(filePath);
        });
        writeChains.set(id, operation);
        operation.finally(() => {
            if (writeChains.get(id) === operation) writeChains.delete(id);
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

    async _resolveVehicleDependency(actorId, vehicleId) {
        const builtIn = getBuiltInVehicleManifest(vehicleId);
        const manifest = builtIn ?? await this.getVehicleManifest(vehicleId);
        if (!manifest) throw new Error(`Vehicle "${vehicleId}" does not exist.`);
        const assetHashes = {};
        if (!builtIn) {
            for (const fileName of (await this.listVehicleAssets(vehicleId)).sort()) {
                const bytes = await this.readVehicleAsset(vehicleId, fileName);
                assetHashes[fileName] = createHash("sha256").update(bytes).digest("hex");
            }
            const modelAsset = String(manifest.model?.asset ?? "").trim();
            if (modelAsset && !modelAsset.startsWith("/") && !/^https?:\/\//i.test(modelAsset)
                && !Object.hasOwn(assetHashes, modelAsset)) {
                throw new Error(`Vehicle "${vehicleId}" is missing model asset "${modelAsset}".`);
            }
        }
        Object.assign(assetHashes, await hashPublicVehicleAssets(manifest));
        return {
            actorId,
            vehicleId,
            manifest,
            assetHashes,
            hash: semanticHash({ manifest, assetHashes }),
        };
    }

    async _resolveEnvironment(environmentId) {
        const stored = await this.getEnvironment(environmentId);
        if (stored) return stored;
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

    _scenarioPath(scenarioId) {
        return path.join(this.scenariosDir, `${safeSegment(scenarioId)}.json`);
    }

    _experimentSuitePath(suiteId) {
        return path.join(this.experimentSuitesDir, `${safeSegment(suiteId)}.json`);
    }

    _experimentResultPath(resultId) {
        return path.join(this.experimentResultsDir, `${safeSegment(resultId)}.json`);
    }

    _experimentBaselinePath(baselineId) {
        return path.join(this.experimentBaselinesDir, `${safeSegment(baselineId)}.json`);
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

function scenarioValidationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "scenario"}: ${issue.message}`).join("; ");
    return new Error(`Scenario validation failed: ${detail}`);
}

function experimentValidationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "suite"}: ${issue.message}`).join("; ");
    return new Error(`Experiment suite validation failed: ${detail}`);
}

function experimentResultValidationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "result"}: ${issue.message}`).join("; ");
    return new Error(`Experiment result validation failed: ${detail}`);
}

function experimentBaselineValidationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "baseline"}: ${issue.message}`).join("; ");
    return new Error(`Experiment baseline validation failed: ${detail}`);
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

function scenarioSummary(scenario) {
    return {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        folderId: scenario.folderId ?? null,
        revision: scenario.revision,
        definitionHash: scenario.definitionHash,
        environmentId: scenario.environment?.id,
        actorCount: scenario.actors?.length ?? 0,
        updatedAt: scenario.updatedAt,
    };
}

function experimentSuiteSummary(suite) {
    return {
        id: suite.id,
        name: suite.name,
        description: suite.description,
        scenarioIds: suite.scenarioIds ?? [],
        manifestIds: suite.manifestIds ?? [],
        revision: suite.revision,
        definitionHash: suite.definitionHash,
        updatedAt: suite.updatedAt,
    };
}

function experimentResultSummary(result) {
    return {
        id: result.id,
        suiteId: result.suiteId,
        status: result.status,
        revision: result.revision,
        definitionHash: result.definitionHash,
        summary: result.summary,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
    };
}

function experimentBaselineSummary(baseline) {
    return {
        id: baseline.id,
        name: baseline.name,
        description: baseline.description,
        suiteId: baseline.suiteId,
        sourceResultId: baseline.sourceResultId,
        definitionHash: baseline.definitionHash,
        createdAt: baseline.createdAt,
    };
}

function experimentCaseIdentityMatches(entry, requested = {}) {
    if (requested.key) return requested.key === entry.key;
    return requested.scenarioId === entry.scenarioId
        && requested.manifestId === entry.manifestId
        && canonicalStringify(requested.seed) === canonicalStringify(entry.seed)
        && canonicalStringify(requested.parameters ?? requested.parameterValues ?? {})
            === canonicalStringify(entry.parameters ?? {});
}

function objectValues(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function collectScenarioScriptIds(scenario) {
    const ids = new Set();
    for (const route of scenario.routes) {
        if (route.controller?.scriptId) ids.add(route.controller.scriptId);
    }
    for (const trigger of scenario.triggers) {
        for (const action of trigger.actions) if (action.scriptId) ids.add(action.scriptId);
    }
    for (const completion of scenario.completion.conditions) if (completion.scriptId) ids.add(completion.scriptId);
    for (const outcome of scenario.expectedOutcomes) if (outcome.scriptId) ids.add(outcome.scriptId);
    return [...ids].sort((left, right) => left.localeCompare(right));
}

function parameterValueMatches(type, value) {
    if (type === "boolean") return typeof value === "boolean";
    if (type === "string") return typeof value === "string";
    if (type === "int32") return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    return typeof value === "number" && Number.isFinite(value);
}

function resolveDeclaredParameters(declarations = [], requested = {}, owner = "document") {
    const values = {};
    const bindings = [];
    const known = new Set(declarations.map((entry) => entry.id));
    for (const key of Object.keys(requested)) {
        if (!known.has(key)) throw new Error(`Parameter "${key}" is not declared by this ${owner}.`);
    }
    for (const declaration of declarations) {
        const value = Object.hasOwn(requested, declaration.id) ? requested[declaration.id] : declaration.default;
        if (!parameterValueMatches(declaration.type, value)) {
            throw new Error(`Parameter "${declaration.id}" requires a ${declaration.type} value.`);
        }
        values[declaration.id] = value;
        bindings.push({
            id: declaration.id,
            type: declaration.type,
            target: structuredClone(declaration.target),
            value: structuredClone(value),
        });
    }
    return { values, bindings };
}

function applyDocumentScalarParameters(source, declarations, values, owner = "document") {
    const document = structuredClone(source);
    for (const declaration of declarations) {
        const target = declaration.target ?? {};
        if (!["scalar", "scalar-field"].includes(target.kind)) continue;
        const resolvedTarget = validateScalarParameterTarget(document, declaration, {
            owner: owner === "scenario" ? "scenario" : "run",
        });
        if (!resolvedTarget.ok) throw new Error(`Parameter "${declaration.id}": ${resolvedTarget.message}`);
        const pathParts = resolvedTarget.pathParts;
        let parent = document;
        for (const part of pathParts.slice(0, -1)) {
            if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)) {
                throw new Error(`Parameter "${declaration.id}" targets missing field "${target.path}".`);
            }
            parent = parent[part];
        }
        const leaf = pathParts.at(-1);
        if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, leaf) || (parent[leaf] !== null && typeof parent[leaf] === "object")) {
            throw new Error(`Parameter "${declaration.id}" must target an existing scalar field.`);
        }
        parent[leaf] = structuredClone(values[declaration.id]);
    }
    return document;
}

function assertScalarParameterValuesPreserved(document, declarations, values, owner) {
    for (const declaration of declarations) {
        if (declaration.target?.kind !== "scalar-field") continue;
        const target = validateScalarParameterTarget(document, declaration, {
            owner: owner === "scenario" ? "scenario" : "run",
        });
        if (!target.ok || !Object.is(target.value, values[declaration.id])) {
            throw new Error(`Parameter "${declaration.id}" produced a value rejected or changed by ${owner} validation.`);
        }
    }
}

function scenarioUsesExternalController(scenario) {
    return scenario.routes.some((route) => route.controller?.kind === "external-ros");
}

function buildScenarioInitialVehicles(scenario, egoVehicleId) {
    const routes = new Map(scenario.routes.map((route) => [route.actorId, route]));
    return scenario.actors.filter((actor) => actor.enabled !== false).map((actor) => {
        const route = routes.get(actor.id);
        const start = route?.waypoints?.[0];
        const routeStart = route?.verification?.polyline?.[0];
        const routeNext = route?.verification?.polyline?.[1];
        // Vehicles move along local +X. Under Three.js yaw, local +X maps to
        // world (cos(yaw), 0, -sin(yaw)), so world XZ route tangents require
        // the negated atan2 used by the deterministic route follower.
        const tangentHeading = routeStart && routeNext
            ? -Math.atan2(Number(routeNext.z || 0) - Number(routeStart.z || 0), Number(routeNext.x || 0) - Number(routeStart.x || 0))
            : 0;
        const heading = Number.isFinite(Number(start?.heading)) && Number(start.heading) !== 0
            ? Number(start.heading)
            : tangentHeading;
        const speed = Number(route?.initialSpeedMps || 0);
        return {
            id: actor.id,
            role: actor.id === "ego" ? "ego" : actor.role,
            type: actor.id === "ego" ? egoVehicleId : actor.vehicleId,
            pose: {
                position: {
                    x: Number(start?.position?.x || 0),
                    y: Number(start?.position?.y || 0),
                    z: Number(start?.position?.z || 0),
                },
                rotation: { x: 0, y: heading, z: 0, order: "XYZ" },
            },
            linearVelocity: {
                x: speed,
                y: 0,
                z: 0,
            },
            steeringAngle: 0,
        };
    });
}

function validateScenarioSensorBindings(scenario, manifest) {
    const sensors = new Map(manifest.sensorRig.sensors.map((sensor) => [sensor.id, sensor]));
    const bindings = manifest.scenario?.sensorBindings ?? {};
    for (const alias of scenario.sensorAliases) {
        const sensorId = bindings[alias.id];
        if (!sensorId) throw new Error(`Scenario sensor alias "${alias.id}" is not bound by the run manifest.`);
        const sensor = sensors.get(sensorId);
        if (!sensor) throw new Error(`Scenario sensor alias "${alias.id}" references missing sensor "${sensorId}".`);
        if (alias.type && sensor.type !== alias.type) {
            throw new Error(`Scenario sensor alias "${alias.id}" requires ${alias.type}, received ${sensor.type}.`);
        }
    }
    const topics = new Map(manifest.topics.map((topic) => [topic.id, topic]));
    for (const route of scenario.routes) {
        if (route.controller.kind !== "external-ros") continue;
        const topic = topics.get(route.controller.topicId);
        if (!topic || topic.direction !== "input") {
            throw new Error(`External ROS route "${route.id}" requires an input command topic.`);
        }
    }
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

function validateEnvironmentId(value) {
    const text = String(value ?? "").trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text)) {
        throw new Error("Environment id must contain only lowercase letters, numbers, and single hyphens.");
    }
    return text;
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
