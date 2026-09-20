import { PLUGIN_CAPABILITIES } from "../plugin-api/capabilities.js";
import { BlockRegistry } from "../scripting/BlockRegistry.js";
import { registerBuiltInBlocks } from "../scripting/registerBuiltInBlocks.js";
import {
    describeBuiltInCatalog,
    describePluginCatalogUnit,
} from "../scripting/UnitCatalog.describe.js";
import { PluginHost } from "./PluginHost.js";
import { PluginLoader } from "./PluginLoader.js";
import { verifyPluginPackage } from "./PluginPackage.js";
import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";
import { comparePluginText } from "./PluginSelection.js";
import { normalizeGraphPluginLocks } from "./PluginGraphLocks.js";

export {
    normalizeGraphPluginLock,
    normalizeGraphPluginLocks,
    stampGraphPluginLock,
    portsForAuthoringNode,
    pluginOwnershipFromUnit,
} from "./PluginGraphLocks.js";

export function buildRevisionedUnitCatalog({ library = { revision: 0, packages: [] }, documents = [] } = {}) {
    const revision = Number.isSafeInteger(library.revision) ? library.revision : 0;
    const units = describeBuiltInCatalog();
    const metadataByHash = new Map((library.packages || []).map((entry) => [entry.packageHash, entry]));
    const pluginUnits = [];
    for (const item of documents) {
        const document = item.document;
        const metadata = item.metadata || metadataByHash.get(item.resource?.packageHash) || {
            pluginId: document.id,
            version: document.version,
            packageHash: item.resource?.packageHash,
            runtimeHash: item.resource?.runtimeHash,
            ...(item.resource?.uiHash ? { uiHash: item.resource.uiHash } : {}),
        };
        for (const unit of document.units || []) {
            pluginUnits.push(describePluginCatalogUnit(unit, metadata, document));
        }
    }
    pluginUnits.sort((left, right) => comparePluginText(left.type, right.type)
        || comparePluginText(left.ownership.packageHash, right.ownership.packageHash));
    return {
        ok: true,
        revision,
        units: [...units, ...pluginUnits],
    };
}

export async function createAuthoringRegistry({
    locks = [],
    getPackage,
    moduleSource,
    simulatorVersion = "0.1.0",
    availableCapabilities = PLUGIN_CAPABILITIES,
} = {}) {
    if (typeof getPackage !== "function") throw new Error("createAuthoringRegistry requires getPackage.");
    if (!moduleSource || typeof moduleSource.importRuntime !== "function") {
        throw new Error("createAuthoringRegistry requires a module source.");
    }
    const normalizedLocks = normalizeGraphPluginLocks(locks);
    const blockRegistry = registerBuiltInBlocks(new BlockRegistry({ allowPlugins: true }));
    const host = new PluginHost({
        blockRegistry,
        simulatorVersion,
        availableCapabilities: [...availableCapabilities],
    });
    const loader = new PluginLoader({ moduleSource, host });
    const unresolvedTypes = [];
    const errors = [];
    for (const lock of normalizedLocks) {
        try {
            const resource = await getPackage(lock.packageHash);
            const verified = verifyPluginPackage(resource);
            if (verified.document.id !== lock.pluginId
                || verified.document.version !== lock.version
                || verified.resource.runtimeHash !== lock.runtimeHash
                || verified.resource.packageHash !== lock.packageHash) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.INTEGRITY,
                    `Plugin lock for "${lock.pluginId}" does not match package ${lock.packageHash}.`,
                    { pluginId: lock.pluginId, packageHash: lock.packageHash },
                );
            }
            await loader.loadPackage(verified.resource, { capabilities: [...verified.document.capabilities] });
        } catch (error) {
            const wrapped = error?.code
                ? error
                : pluginError(PLUGIN_ERROR_CODES.INTEGRITY, error.message, {
                    pluginId: lock.pluginId,
                    packageHash: lock.packageHash,
                    cause: error,
                });
            errors.push(wrapped);
            unresolvedTypes.push(...lock.types);
        }
    }
    host.seal();
    return {
        registry: host.blockRegistry,
        host,
        loader,
        locks: normalizedLocks,
        unresolvedTypes: [...new Set(unresolvedTypes)].sort(comparePluginText),
        errors,
        dispose() {
            this.disposed = true;
        },
    };
}
