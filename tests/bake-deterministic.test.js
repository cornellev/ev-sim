import assert from "node:assert/strict";
import test from "node:test";

import { SeededRNG } from "../app/util/SeededRNG.js";

test("SeededRNG is deterministic for the same seed", () => {
    const a = new SeededRNG(42);
    const b = new SeededRNG(42);
    const samplesA = Array.from({ length: 5 }, () => a.next());
    const samplesB = Array.from({ length: 5 }, () => b.next());
    assert.deepEqual(samplesA, samplesB);
});

test("SeededRNG changes with different seeds", () => {
    const a = new SeededRNG(42);
    const b = new SeededRNG(43);
    assert.notEqual(a.next(), b.next());
});

test("SeededRNG fork produces stable child streams", () => {
    const parent = new SeededRNG("igvc");
    const child = parent.fork("building-0");
    const again = parent.fork("building-0");
    assert.equal(child.next(), again.next());
});
