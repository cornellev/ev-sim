import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";

export function resolveMarketplaceConfig(env = process.env) {
    const raw = env?.CEV_SIM_MARKETPLACE_ENABLED;
    let enabled;
    if (raw === undefined || raw === "" || ["1", "true"].includes(raw)) enabled = true;
    else if (["0", "false"].includes(raw)) enabled = false;
    else {
        throw marketplaceError(
            MARKETPLACE_ERROR_CODES.CONFIG_INVALID,
            "CEV_SIM_MARKETPLACE_ENABLED must be one of: 0, 1, false, true.",
            { path: "CEV_SIM_MARKETPLACE_ENABLED" },
        );
    }
    const connectionsDir = env?.CEV_SIM_MARKETPLACE_CONNECTIONS_DIR;
    if (connectionsDir !== undefined && (typeof connectionsDir !== "string" || !connectionsDir || connectionsDir.includes("\u0000"))) {
        throw marketplaceError(
            MARKETPLACE_ERROR_CODES.CONFIG_INVALID,
            "CEV_SIM_MARKETPLACE_CONNECTIONS_DIR must be a non-empty path.",
            { path: "CEV_SIM_MARKETPLACE_CONNECTIONS_DIR" },
        );
    }
    return Object.freeze({ enabled, ...(connectionsDir ? { connectionsDir } : {}) });
}
