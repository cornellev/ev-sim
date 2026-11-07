import assert from "node:assert/strict";
import test from "node:test";

import { pickFromHitObject } from "../app/vehicles/editor/modelPartPick.js";

function object(parent = null, pick = null) {
    return { userData: pick ? { pick } : {}, parent };
}

test("a wheel pick wins over a mapped node", () => {
    const mesh = object(null, { kind: "wheel", id: "front-left" });
    const mappings = new Map([[mesh, { nodeIndex: 4 }]]);
    assert.deepEqual(pickFromHitObject(mesh, mappings), { kind: "wheel", id: "front-left" });
});

test("a mapped mesh returns that node", () => {
    const mesh = object();
    const mappings = new Map([[mesh, { nodeIndex: 3 }]]);
    assert.deepEqual(pickFromHitObject(mesh, mappings), { kind: "model-node", id: "node-3" });
});

test("an unmapped child uses its parent node", () => {
    const parent = object();
    const child = object(parent);
    const mappings = new Map([[parent, { nodeIndex: 1 }]]);
    assert.deepEqual(pickFromHitObject(child, mappings), { kind: "model-node", id: "node-1" });
});

test("a miss returns null and a placeholder pick selects the model", () => {
    const mesh = object();
    assert.equal(pickFromHitObject(mesh, new Map()), null);
    assert.equal(pickFromHitObject(null, new Map()), null);
    const placeholder = object(null, { kind: "model", id: null });
    assert.deepEqual(pickFromHitObject(placeholder, new Map()), { kind: "model", id: null });
    const child = object(mesh);
    mesh.parent = child;
    assert.equal(pickFromHitObject(child, new Map()), null);
});
