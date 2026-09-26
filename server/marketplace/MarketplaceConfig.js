import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";

export function resolveMarketplaceConfig(env = process.env) {
    const raw = env?.CEV_SIM_MARKETPLACE_ENABLED;
    if (raw === undefined || ["", "0", "false"].includes(raw)) return Object.freeze({ enabled: false });
    if (["1", "true"].includes(raw)) return Object.freeze({ enabled: true });
    throw marketplaceError(
        MARKETPLACE_ERROR_CODES.CONFIG_INVALID,
        "CEV_SIM_MARKETPLACE_ENABLED must be one of: 0, 1, false, true.",
        { path: "CEV_SIM_MARKETPLACE_ENABLED" },
    );
}
