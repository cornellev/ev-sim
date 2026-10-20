import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateDynamicBicycleCharacterization } from "./helpers/dynamicBicycleCharacterization.js";

const fixtureUrl = new URL("fixtures/headless/characterization.dynamic-bicycle.v1.json", import.meta.url);

test("dynamic bicycle characterization regenerates from the current plant", async () => {
    const expected = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const generated = await generateDynamicBicycleCharacterization();
    assert.equal(generated.kind, "cev-sim.vehicle.dynamic-bicycle-characterization");
    assert.equal(generated.id, "dynamic-bicycle-v1");
    assert.deepEqual(generated, expected);
});
