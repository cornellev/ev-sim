import assert from "node:assert/strict";
import test from "node:test";

import { measurePlacedVehicleModel } from "../app/vehicles/model/measurePlacedVehicle.js";
import { normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import {
    buildWheelAssignmentState,
    canonicalVehicleGlb,
    rolesFromManifest,
} from "../app/vehicles/editor/wheelAssignmentState.js";
import { buildBoxGlb, symmetricWheelParts } from "./helpers/vehicle-wheel-glb.js";

function measured(parts = symmetricWheelParts()) {
    const glb = buildBoxGlb(parts);
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "assign",
        model: { asset: `${"aa".repeat(32)}.glb` },
    });
    return measurePlacedVehicleModel({
        glbBytes: glb,
        model: manifest.model,
        boundingBox: manifest.boundingBox,
    });
}

test("assignment state accepts a symmetric pair and reports an asymmetric one", () => {
    const measurement = measured();
    const ready = buildWheelAssignmentState({
        catalog: measurement.catalog,
        measurement,
        roles: { 0: "front-left", 1: "front-right" },
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.pairs.length, 1);
    assert.equal(ready.pairs[0].withinTolerance, true);
    assert.equal(ready.entries[0].name, "wheel-left");
    assert.match(ready.entries[0].path, /wheel-left/);

    const partial = buildWheelAssignmentState({
        catalog: measurement.catalog,
        measurement,
        roles: { 0: "front-left" },
    });
    assert.equal(partial.ready, false);
    assert.match(partial.messages.join(" "), /both sides/);

    const shifted = symmetricWheelParts();
    shifted[1] = { ...shifted[1], center: { x: 0.875, y: 0.25, z: -0.5 } };
    const asymmetric = measured(shifted);
    const rejected = buildWheelAssignmentState({
        catalog: asymmetric.catalog,
        measurement: asymmetric,
        roles: { 0: "front-left", 1: "front-right" },
    });
    assert.equal(rejected.ready, false);
    assert.equal(rejected.outOfTolerance.length, 1);
    assert.equal(rejected.outOfTolerance[0].axle, "front");
});

test("assignment roles come from bound wheels and canonical names are recognized", () => {
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "roles",
        model: { asset: `${"ab".repeat(32)}.glb` },
        wheels: [
            { id: "front-left", axle: "front", side: "left", position: { x: 1, y: 0.25, z: 0.5 }, radius: 0.25, width: 0.25, steerable: true, visual: { kind: "model-node", nodeIndex: 3 } },
        ],
    });
    assert.deepEqual(rolesFromManifest(manifest), { 3: "front-left" });
    assert.equal(canonicalVehicleGlb(manifest.model.asset), true);
    assert.equal(canonicalVehicleGlb("model.glb"), false);
    assert.equal(canonicalVehicleGlb(`${"ab".repeat(32)}.gltf`), false);
});
