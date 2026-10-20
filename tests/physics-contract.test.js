import assert from "node:assert/strict";
import test from "node:test";

import { simulationSha256 } from "../app/simulation/kernel/SimulationHashes.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import {
    DEFAULT_DYNAMIC_BICYCLE,
    DYNAMIC_BICYCLE_MODEL,
    KINEMATIC_BICYCLE_MODEL,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";

test("dynamic bicycle dynamics fill defaults and kinematic dynamics stay absent", () => {
    const absent = normalizeVehicleManifest({ id: "hash-car" });
    const kinematic = normalizeVehicleManifest({
        id: "hash-car",
        dynamics: { model: KINEMATIC_BICYCLE_MODEL },
    });
    assert.equal(absent.dynamics, undefined);
    assert.deepEqual(kinematic, absent);
    assert.equal(simulationSha256(kinematic), simulationSha256(absent));

    const dynamic = normalizeVehicleManifest({
        id: "hash-car",
        dynamics: { model: DYNAMIC_BICYCLE_MODEL, mass: 900, rollingResistance: 0 },
    });
    assert.deepEqual(dynamic.dynamics, {
        model: DYNAMIC_BICYCLE_MODEL,
        ...DEFAULT_DYNAMIC_BICYCLE,
        mass: 900,
        rollingResistance: 0,
    });
    assert.notEqual(simulationSha256(dynamic), simulationSha256(absent));
    assert.deepEqual(
        normalizeVehicleManifest({ id: "hash-car", dynamics: { plant: "example.plant" } }).dynamics,
        { plant: "example.plant" },
    );
});

test("vehicle dynamics rejects unknown models, stray physical fields, and a plugin plant on the dynamic model", () => {
    assert.throws(
        () => normalizeVehicleManifest({ id: "hash-car", dynamics: { model: "pacejka" } }),
        /not a known motion model/,
    );
    assert.throws(
        () => normalizeVehicleManifest({ id: "hash-car", dynamics: { drag: 1 } }),
        /unknown field "drag"/,
    );
    assert.throws(
        () => normalizeVehicleManifest({ id: "hash-car", dynamics: { mass: 1000 } }),
        /physical fields require model/,
    );
    assert.throws(
        () => normalizeVehicleManifest({
            id: "hash-car",
            dynamics: { model: KINEMATIC_BICYCLE_MODEL, mass: 1000 },
        }),
        /physical fields require model/,
    );
    assert.throws(
        () => normalizeVehicleManifest({
            id: "hash-car",
            dynamics: { plant: "example.plant", model: DYNAMIC_BICYCLE_MODEL },
        }),
        /cannot be combined/,
    );
    assert.throws(
        () => normalizeVehicleManifest({
            id: "hash-car",
            dynamics: { model: DYNAMIC_BICYCLE_MODEL, mass: 0 },
        }),
        /dynamics\.mass/,
    );
    assert.throws(
        () => normalizeVehicleManifest({
            id: "hash-car",
            dynamics: { model: DYNAMIC_BICYCLE_MODEL, frictionMu: -1 },
        }),
        /dynamics\.frictionMu/,
    );
    assert.throws(
        () => normalizeVehicleManifest({
            id: "hash-car",
            dynamics: { model: DYNAMIC_BICYCLE_MODEL, rollingResistance: -0.1 },
        }),
        /dynamics\.rollingResistance/,
    );
});

test("the plant factory accepts dynamic-bicycle and refuses to integrate it", () => {
    const manifest = normalizeVehicleManifest({
        id: "dyno",
        dynamics: { model: DYNAMIC_BICYCLE_MODEL },
    });
    const definition = createVehiclePlantDefinition({ id: "ego" }, { manifest });
    assert.equal(definition.motionModel, "dynamic-bicycle");
    assert.equal(definition.version, 1);
    assert.deepEqual(definition.dynamics, manifest.dynamics);
    assert.throws(() => new KinematicVehiclePlant(definition), /not available yet/);
    assert.throws(
        () => createVehiclePlantDefinition({}, null, { motionModel: "dynamic-bicycle" }),
        /requires manifest\.dynamics\.model/,
    );
});

test("built-in vehicles stay on the kinematic bicycle", () => {
    for (const type of ["big-car", "igvc-car", "scenario-car"]) {
        const manifest = getBuiltInVehicleManifest(type);
        assert.equal(manifest.dynamics, undefined);
        const definition = createVehiclePlantDefinition({ type });
        assert.equal(definition.motionModel, type === "scenario-car" ? "scenario-keyframes" : "bicycle");
        assert.equal(definition.dynamics, undefined);
    }
});
