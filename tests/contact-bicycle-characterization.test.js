import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateContactBicycleCharacterization } from "./helpers/contactBicycleCharacterization.js";

const fixtureUrl = new URL("fixtures/headless/characterization.contact-bicycle.v2.json", import.meta.url);

test("contact bicycle characterization regenerates from the chassis", async () => {
    const expected = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const generated = await generateContactBicycleCharacterization();
    assert.equal(generated.kind, "cev-sim.vehicle.contact-bicycle-characterization");
    assert.equal(generated.id, "contact-bicycle-v2");
    assert.deepEqual(generated, expected);
});
