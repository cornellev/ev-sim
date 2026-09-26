import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveMarketplaceConfig } from "../server/marketplace/MarketplaceConfig.js";

test("MKT-01 marketplace startup seam is frozen and disabled by default", () => {
    for (const value of [undefined, "", "0", "false"]) {
        const config = resolveMarketplaceConfig(value === undefined ? {} : { CEV_SIM_MARKETPLACE_ENABLED: value });
        assert.deepEqual(config, { enabled: false });
        assert.equal(Object.isFrozen(config), true);
    }
    for (const value of ["1", "true"]) {
        assert.deepEqual(resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_ENABLED: value }), { enabled: true });
    }
    assert.throws(
        () => resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_ENABLED: "yes" }),
        (error) => error.code === "CONFIG_INVALID" && /must be one of/.test(error.message),
    );
    for (const value of [" FALSE ", "TRUE", " false", "00", 1]) {
        assert.throws(() => resolveMarketplaceConfig({ CEV_SIM_MARKETPLACE_ENABLED: value }), /must be one of/);
    }
    assert.notEqual(resolveMarketplaceConfig({}), resolveMarketplaceConfig({}));
});

test("MKT-01 server startup only stores the dormant marketplace configuration", async () => {
    const source = await readFile(new URL("../server/App.js", import.meta.url), "utf8");
    assert.match(source, /loadEnvConfig[\s\S]+resolveMarketplaceConfig[\s\S]+server\.locals\.marketplaceConfig/);
    assert.equal(source.match(/marketplace\//g)?.length, 1);
    assert.doesNotMatch(source, /marketplace(?:Router|Service|Directory|Listener)/);
});
