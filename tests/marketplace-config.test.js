import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveMarketplaceConfig } from "../server/marketplace/MarketplaceConfig.js";

const require = createRequire(import.meta.url);
const { startup } = require("../server/startup.js");

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

function captureStartup(env) {
    const logs = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));
    console.warn = () => {};
    try {
        return { ready: startup("/repo", env), logs, errors };
    } finally {
        console.log = originalLog;
        console.error = originalError;
        console.warn = originalWarn;
    }
}

test("startup marketplace log matches the default-on kill switch", () => {
    for (const value of [undefined, "", "1", "true"]) {
        const env = value === undefined ? {} : { CEV_SIM_MARKETPLACE_ENABLED: value };
        const result = captureStartup(env);
        assert.equal(result.ready, true);
        assert.ok(result.logs.some((line) => line.includes("[MARKETPLACE] Marketplace is enabled.")));
        assert.equal(result.logs.some((line) => line.includes("Marketplace is disabled.")), false);
    }
    for (const value of ["0", "false"]) {
        const result = captureStartup({ CEV_SIM_MARKETPLACE_ENABLED: value });
        assert.equal(result.ready, true);
        assert.ok(result.logs.some((line) => line.includes("[MARKETPLACE] Marketplace is disabled.")));
        assert.equal(result.logs.some((line) => line.includes("Marketplace is enabled.")), false);
    }
    const invalid = captureStartup({ CEV_SIM_MARKETPLACE_ENABLED: "yes" });
    assert.equal(invalid.ready, false);
    assert.match(invalid.errors.join("\n"), /CEV_SIM_MARKETPLACE_ENABLED must be one of: 0, 1, false, true/);
    assert.equal(invalid.logs.some((line) => line.includes("[MARKETPLACE]")), false);
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
