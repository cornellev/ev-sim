import { PLUGIN_CAPABILITIES } from "../../plugin-api/capabilities.js";
import { BlockRegistry } from "../../scripting/BlockRegistry.js";
import { registerBuiltInBlocks } from "../../scripting/registerBuiltInBlocks.js";
import { PluginHost } from "../PluginHost.js";
import { PluginLoader } from "../PluginLoader.js";
import { verifyPluginPackage } from "../PluginPackage.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../PluginErrors.js";
import { BrowserPluginModuleSource } from "./BrowserPluginModuleSource.js";
import { PluginUiHost } from "./PluginUiHost.js";

export class BrowserPluginAuthoringSession {
    constructor({
        moduleSource = new BrowserPluginModuleSource(),
        availableCapabilities = PLUGIN_CAPABILITIES,
        simulatorVersion = "0.1.0",
    } = {}) {
        this.moduleSource = moduleSource;
        this.host = new PluginHost({
            blockRegistry: registerBuiltInBlocks(new BlockRegistry({ allowPlugins: true })),
            availableCapabilities: [...availableCapabilities],
            simulatorVersion,
        });
        this.loader = new PluginLoader({ moduleSource, host: this.host });
        this.uiHost = new PluginUiHost({ moduleSource });
        this.loaded = new Map();
        this.verified = new Map();
    }

    get registry() {
        return this.host.blockRegistry;
    }

    getBlockClass(type) {
        return this.registry.get(type);
    }

    async fetchPackage(packageHash) {
        const response = await fetch(`/api/storage/plugins/packages/${packageHash}`);
        if (!response.ok) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin package ${packageHash} is unavailable.`, { packageHash });
        }
        return response.json();
    }

    async loadLock(lock) {
        if (this.loaded.has(lock.packageHash)) return this.verified.get(lock.packageHash);
        if (this.host.packages.has(lock.pluginId)) {
            const current = this.host.packages.get(lock.pluginId);
            if (current.packageHash !== lock.packageHash) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.REGISTRATION,
                    `Authoring session already loaded "${lock.pluginId}" as ${current.packageHash}.`,
                    { pluginId: lock.pluginId, packageHash: lock.packageHash },
                );
            }
            return this.verified.get(current.packageHash);
        }
        const resource = await this.fetchPackage(lock.packageHash);
        const verified = verifyPluginPackage(resource);
        await this.loader.loadPackage(verified.resource, { capabilities: [...verified.document.capabilities] });
        await this.uiHost.loadPackageUi(verified);
        this.loaded.set(lock.packageHash, lock);
        this.verified.set(lock.packageHash, verified);
        return verified;
    }

    viewFor(type) {
        return this.uiHost.get(type);
    }

    diagnosticFor(type) {
        return this.uiHost.diagnostic(type);
    }

    dispose() {
        this.loaded.clear();
        this.verified.clear();
        this.uiHost = new PluginUiHost({ moduleSource: this.moduleSource });
    }
}
