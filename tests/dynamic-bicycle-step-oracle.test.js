import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import { buildDynamicBicycleStepOracle } from "./helpers/dynamicBicycleStepOracle.js";

const fixtureUrl = new URL("fixtures/plugins/dynamic-bicycle-steps.json", import.meta.url);

test("the dynamic bicycle step oracle matches stepDynamicBicycle", async () => {
    const committed = JSON.parse(await fs.readFile(fixtureUrl, "utf8"));
    assert.deepEqual(buildDynamicBicycleStepOracle(), committed);
});
