import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveMarketplaceConfig } from "../server/marketplace/MarketplaceConfig.js";

test("MKT-16 prerequisite enables Marketplace by default and preserves the explicit kill switch", () => {
    for (const value of [undefined, ""]) {
        const config = resolveMarketplaceConfig(value === undefined ? {} : { CEV_SIM_MARKETPLACE_ENABLED: value });
        assert.deepEqual(config, { enabled: true });
        assert.equal(Object.isFrozen(config), true);
    }
    for (const value of ["1", "true"]) {
        assert.deepEqual(resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_ENABLED: value }), { enabled: true });
    }
    for (const value of ["0", "false"]) {
        assert.deepEqual(resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_ENABLED: value }), { enabled: false });
    }
    assert.throws(
        () => resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_ENABLED: "yes" }),
        (error) => error.code === "CONFIG_INVALID" && /must be one of/.test(error.message),
    );
    for (const value of [" FALSE ", "TRUE", " false", "00", 1]) {
        assert.throws(() => resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_ENABLED: value }), /must be one of/);
    }
    assert.notEqual(resolveMarketplaceConfig({}), resolveMarketplaceConfig({}));
    assert.deepEqual(resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_CONNECTIONS_DIR: "/operator/connections" }), {
        enabled: true,
        connectionsDir: "/operator/connections",
    });
});

test("MKT-07 server startup constructs Marketplace after supervisor initialization and mounts it only when enabled", async () => {
    const source = await readFile(new URL("../server/App.js", import.meta.url), "utf8");
    assert.match(source, /loadEnvConfig[\s\S]+resolveMarketplaceConfig[\s\S]+server\.locals\.marketplaceConfig/);
    assert.match(source, /if \(server\.locals\.marketplaceConfig\.enabled\)[\s\S]+marketplaceServiceModule\.MarketplaceService/);
    assert.ok(source.indexOf("await headlessExperimentService.initialize()") < source.indexOf("MarketplaceService.open(storageService.dataDir"));
    assert.match(source, /hostProfileProvider:[\s\S]+supervisor\.getCapabilities/);
    assert.match(source, /if \(marketplaceService\) server\.use\('\/api\/marketplace'/);
    assert.match(source, /await marketplaceService\?\.close\(\)/);
});
