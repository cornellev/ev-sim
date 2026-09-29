import { PLUGIN_CAPABILITIES } from "../../plugin-api/capabilities.js";
import { BlockRegistry } from "../../scripting/BlockRegistry.js";
import { registerBuiltInBlocks } from "../../scripting/registerBuiltInBlocks.js";
import { PluginHost } from "../PluginHost.js";
import { PluginLoader } from "../PluginLoader.js";
import { verifyPluginPackage } from "../PluginPackage.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../PluginErrors.js";
import { BrowserPluginModuleSource } from "./BrowserPluginModuleSource.js";
import { PluginUiHost } from "./PluginUiHost.js";
import {
    announceMarketplaceReloadRequired,
    authorizeBrowserPackage,
    subscribeBrowserMarketplacePolicy,
} from "./BrowserMarketplacePolicy.js";

export class BrowserPluginAuthoringSession {
    constructor({
        moduleSource = new BrowserPluginModuleSource(),
        availableCapabilities = PLUGIN_CAPABILITIES,
        simulatorVersion = "0.1.0",
        authorizePackage = typeof window === "undefined" ? null : authorizeBrowserPackage,
        subscribePolicy = typeof window === "undefined" ? null : subscribeBrowserMarketplacePolicy,
    } = {}) {
        this.moduleSource = moduleSource;
        this.host = new PluginHost({
            blockRegistry: registerBuiltInBlocks(new BlockRegistry({ allowPlugins: true })),
            availableCapabilities: [...availableCapabilities],
            simulatorVersion,
        });
        this.loader = new PluginLoader({ moduleSource, host: this.host, authorizePackage });
        this.authorizePackage = authorizePackage;
        this.uiHost = new PluginUiHost({ moduleSource });
        this.loaded = new Map();
        this.verified = new Map();
        this.reloadRequired = false;
        this.reloadRequiredPackageHashes = [];
        this.unsubscribePolicy = subscribePolicy?.(() => { this.#policyChanged().catch(() => {}); }) ?? null;
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
        if (this.reloadRequired) throw pluginError(PLUGIN_ERROR_CODES.UNAVAILABLE, "Marketplace policy changed; reload this editor before activating plugins.", { requiresReset: true });
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

    async #policyChanged() {
        if (!this.loaded.size || this.reloadRequired) return;
        const denied = [];
        for (const packageHash of this.loaded.keys()) {
            try { await this.authorizePackage?.(packageHash); }
            catch { denied.push(packageHash); }
        }
        if (!denied.length) return;
        this.reloadRequired = true;
        this.reloadRequiredPackageHashes = denied.sort();
        announceMarketplaceReloadRequired(denied);
    }

    dispose() {
        this.unsubscribePolicy?.();
        this.unsubscribePolicy = null;
        this.loaded.clear();
        this.verified.clear();
        this.uiHost = new PluginUiHost({ moduleSource: this.moduleSource });
    }
}
