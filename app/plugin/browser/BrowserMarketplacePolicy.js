import { PLUGIN_ERROR_CODES, pluginError } from "../PluginErrors.js";
import { subscribeMarketplacePolicy } from "../../marketplace/MarketplaceClient.js";

export const MARKETPLACE_RELOAD_REQUIRED_EVENT = "cev-sim-marketplace-reload-required";

export async function authorizeBrowserPackage(packageHash) {
    const response = await fetch(`/api/marketplace/policy/packages/${packageHash}/authorize`, { method: "POST" });
    if (!response.ok) {
        throw pluginError(
            PLUGIN_ERROR_CODES.UNAVAILABLE,
            `Plugin package ${packageHash} is blocked by Marketplace policy.`,
            { packageHash, requiresReset: true },
        );
    }
    return response.json();
}

export function subscribeBrowserMarketplacePolicy(listener) {
    let currentRevision = null;
    return subscribeMarketplacePolicy({
        onPolicy({ revision }) {
            if (currentRevision === null) currentRevision = revision;
            else if (revision !== currentRevision) {
                currentRevision = revision;
                listener(revision);
            }
        },
    });
}

export function announceMarketplaceReloadRequired(packageHashes) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(MARKETPLACE_RELOAD_REQUIRED_EVENT, {
        detail: { packageHashes: [...new Set(packageHashes)].sort() },
    }));
}
