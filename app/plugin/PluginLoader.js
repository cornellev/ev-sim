import { validateCapabilityGrants } from "../plugin-api/capabilities.js";
import { assertPluginCompatibility } from "./PluginDocument.js";
import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";
import { verifyPluginPackage } from "./PluginPackage.js";

export class PluginLoader {
    constructor({ moduleSource, host } = {}) {
        if (!moduleSource || typeof moduleSource.importRuntime !== "function") throw new Error("PluginLoader requires a module source.");
        if (!host || typeof host.registerPackage !== "function") throw new Error("PluginLoader requires a plugin host.");
        this.moduleSource = moduleSource;
        this.host = host;
    }

    async loadPackage(resource, { capabilities = [] } = {}) {
        const verified = verifyPluginPackage(resource);
        assertPluginCompatibility(verified.document, {
            pluginApi: 1,
            simulatorVersion: this.host.simulatorVersion,
        });
        try {
            validateCapabilityGrants(verified.document.capabilities, capabilities, this.host.availableCapabilities);
        } catch (error) {
            throw pluginError(PLUGIN_ERROR_CODES.CAPABILITY, error.message, {
                pluginId: verified.document.id,
                packageHash: verified.resource.packageHash,
                cause: error,
            });
        }
        let namespace;
        try {
            namespace = await this.moduleSource.importRuntime(verified);
        } catch (error) {
            if (error?.code) throw error;
            throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Could not import plugin "${verified.document.id}": ${error.message}`, {
                pluginId: verified.document.id,
                packageHash: verified.resource.packageHash,
                cause: error,
            });
        }
        return this.host.registerPackage(verified, namespace, { capabilities });
    }
}
