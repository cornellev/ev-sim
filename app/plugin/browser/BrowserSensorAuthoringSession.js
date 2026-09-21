import {
    createSensorDefinitionRegistry,
    registerBuiltInSensorTypes,
    SensorTypeRegistry,
} from "../../simulation/sensors/SensorTypeRegistry.js";
import { createPluginSensorTypeDefinition } from "../PluginSensorContract.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../PluginErrors.js";
import { verifyPluginPackage } from "../PluginPackage.js";
import { BrowserPluginModuleSource } from "./BrowserPluginModuleSource.js";
import { PluginUiHost } from "./PluginUiHost.js";

export class BrowserSensorAuthoringSession {
    constructor({
        moduleSource = new BrowserPluginModuleSource(),
        fetchPackage = null,
    } = {}) {
        this.moduleSource = moduleSource;
        this.fetchPackageFn = fetchPackage;
        this.sensorRegistry = registerBuiltInSensorTypes(new SensorTypeRegistry({ allowPlugins: true }));
        this.uiHost = new PluginUiHost({ moduleSource });
        this.loaded = new Map();
        this.verified = new Map();
        this.unresolvedLocks = [];
        this.errors = [];
        this.disposed = false;
    }

    get registry() {
        return this.sensorRegistry;
    }

    registerCatalog(catalog) {
        for (const row of catalog?.sensors ?? []) {
            if (!row?.ownership || row.ownership === "builtin" || typeof row.ownership !== "object") continue;
            if (this.sensorRegistry.has(row.type)) continue;
            this.sensorRegistry.register(
                createPluginSensorTypeDefinition(row.descriptor, {
                    pluginId: row.ownership.pluginId,
                    version: row.ownership.version,
                    runtimeHash: row.ownership.runtimeHash,
                }),
                row.ownership,
            );
        }
        return this.sensorRegistry;
    }

    sensorViewFor(type) {
        return this.uiHost.getSensorView(type);
    }

    diagnosticFor(type) {
        return this.uiHost.diagnostic(type);
    }

    async fetchPackage(packageHash) {
        if (typeof this.fetchPackageFn === "function") return this.fetchPackageFn(packageHash);
        const response = await fetch(`/api/storage/plugins/packages/${packageHash}`);
        if (!response.ok) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin package ${packageHash} is unavailable.`, { packageHash });
        }
        return response.json();
    }

    async loadLock(lock) {
        if (this.disposed) throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Sensor authoring session is disposed.");
        const packageHash = String(lock?.packageHash ?? "").trim();
        if (!packageHash) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Sensor authoring locks require packageHash.");
        }
        if (this.loaded.has(packageHash)) {
            const verified = this.verified.get(packageHash);
            this.#assertLock(lock, verified);
            return verified;
        }
        const existingPlugin = [...this.loaded.values()].find((entry) => entry.pluginId === lock.pluginId);
        if (existingPlugin && existingPlugin.packageHash !== packageHash) {
            throw pluginError(
                PLUGIN_ERROR_CODES.REGISTRATION,
                `Authoring session already loaded "${lock.pluginId}" as ${existingPlugin.packageHash}.`,
                { pluginId: lock.pluginId, packageHash },
            );
        }
        let verified;
        try {
            const resource = await this.fetchPackage(packageHash);
            verified = verifyPluginPackage(resource);
            this.#assertLock(lock, verified);
            const ownership = {
                pluginId: verified.document.id,
                version: verified.document.version,
                runtimeHash: verified.resource.runtimeHash,
            };
            if (!this.loaded.has(packageHash)) {
                for (const descriptor of verified.document.sensorTypes ?? []) {
                    if (!this.sensorRegistry.has(descriptor.type)) {
                        this.sensorRegistry.register(
                            createPluginSensorTypeDefinition(descriptor, ownership),
                            ownership,
                        );
                    }
                }
                await this.uiHost.loadPackageUi(verified);
            }
            this.loaded.set(packageHash, {
                pluginId: verified.document.id,
                version: verified.document.version,
                packageHash: verified.resource.packageHash,
                runtimeHash: verified.resource.runtimeHash,
                sensorTypes: [...(lock.sensorTypes ?? [])],
            });
            this.verified.set(packageHash, verified);
            return verified;
        } catch (error) {
            const wrapped = error?.code
                ? error
                : pluginError(PLUGIN_ERROR_CODES.INTEGRITY, error.message, {
                    pluginId: lock.pluginId,
                    packageHash,
                    cause: error,
                });
            this.errors.push(wrapped);
            this.unresolvedLocks = [...new Set([...this.unresolvedLocks, packageHash])];
            throw wrapped;
        }
    }

    #assertLock(lock, verified) {
        if (lock.pluginId && verified.document.id !== lock.pluginId) {
            throw pluginError(
                PLUGIN_ERROR_CODES.INTEGRITY,
                `Plugin lock for "${lock.pluginId}" does not match package ${verified.resource.packageHash}.`,
                { pluginId: lock.pluginId, packageHash: verified.resource.packageHash },
            );
        }
        if (lock.version && verified.document.version !== lock.version) {
            throw pluginError(
                PLUGIN_ERROR_CODES.INTEGRITY,
                `Plugin lock for "${lock.pluginId}" does not match package ${verified.resource.packageHash}.`,
                { pluginId: lock.pluginId, packageHash: verified.resource.packageHash },
            );
        }
        if (lock.runtimeHash && verified.resource.runtimeHash !== lock.runtimeHash) {
            throw pluginError(
                PLUGIN_ERROR_CODES.INTEGRITY,
                `Plugin lock for "${lock.pluginId}" does not match package ${verified.resource.packageHash}.`,
                { pluginId: lock.pluginId, packageHash: verified.resource.packageHash },
            );
        }
        if (lock.packageHash && verified.resource.packageHash !== lock.packageHash) {
            throw pluginError(
                PLUGIN_ERROR_CODES.INTEGRITY,
                `Plugin lock for "${lock.pluginId}" does not match package ${lock.packageHash}.`,
                { pluginId: lock.pluginId, packageHash: lock.packageHash },
            );
        }
        const declared = new Set((verified.document.sensorTypes ?? []).map((entry) => entry.type));
        for (const type of lock.sensorTypes ?? []) {
            if (!declared.has(type)) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.INTEGRITY,
                    `Plugin "${verified.document.id}" does not declare locked sensor type "${type}".`,
                    { pluginId: verified.document.id, packageHash: verified.resource.packageHash, contributionId: type },
                );
            }
        }
    }

    dispose() {
        this.disposed = true;
        this.loaded.clear();
        this.verified.clear();
        this.unresolvedLocks = [];
        this.errors = [];
        this.sensorRegistry = registerBuiltInSensorTypes(new SensorTypeRegistry({ allowPlugins: true }));
        this.uiHost = new PluginUiHost({ moduleSource: this.moduleSource });
    }
}

export { createSensorDefinitionRegistry };
