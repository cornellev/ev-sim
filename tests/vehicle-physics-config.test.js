import assert from "node:assert/strict";
import test from "node:test";

import { PLANT_CONTACT_BICYCLE_MODEL, resolvePlantParameters } from "../app/plugin/PlantModule.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { contactParameters } from "../app/simulation/vehicles/contactBicycle.js";
import { resolveVehiclePhysicsConfig } from "../app/simulation/vehicles/VehiclePhysicsConfig.js";
import { CONTACT_BICYCLE_MODEL, DEFAULT_DYNAMIC_BICYCLE, normalizeVehicleDynamics, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";

const parameters = Object.entries(DEFAULT_DYNAMIC_BICYCLE).map(([key, value]) => ({ key, source: "default", default: value }));
const plugin = { id: "test.bicycle", model: PLANT_CONTACT_BICYCLE_MODEL, parameters };
const rcDynamics = { mass: 3, yawInertia: 0.03266125, corneringStiffnessFront: 160, corneringStiffnessRear: 160 };
const rc = (dynamics) => normalizeVehicleManifest({ id: "rc-test", kinematics: { wheelbase: 0.18688 }, dynamics });

test("plugin physics overrides stay optional, canonical, positive after rounding, and declared", () => {
    assert.deepEqual(normalizeVehicleDynamics({ plant: plugin.id }), { plant: plugin.id });
    assert.deepEqual(normalizeVehicleDynamics({ plant: plugin.id, mass: 3.1234567 }), { plant: plugin.id, mass: 3.123457 });
    for (const mass of [Infinity, NaN, 0, -1, 0.00000049]) {
        assert.throws(() => normalizeVehicleDynamics({ plant: plugin.id, mass }), /dynamics.mass/);
    }
    assert.equal(normalizeVehicleDynamics({ plant: plugin.id, mass: 0.000001 }).mass, 0.000001);
    const manifest = rc({ plant: plugin.id, ...rcDynamics });
    assert.throws(() => resolveVehiclePhysicsConfig(manifest, { ...plugin, parameters: [] }), /does not support.*mass/);
    assert.throws(() => resolveVehiclePhysicsConfig(manifest, { ...plugin, model: undefined }), /does not support.*mass/);
    assert.equal(resolveVehiclePhysicsConfig(rc({ plant: plugin.id }), { model: undefined }), null);
});

test("one immutable RC config drives builtin and plugin parameters with override > declaration > default", () => {
    const manifest = rc({ plant: plugin.id, ...rcDynamics });
    const config = resolveVehiclePhysicsConfig(manifest, plugin);
    assert.ok(Object.isFrozen(config));
    assert.equal(config.yawInertia, 0.032661);
    assert.equal(config.lf, 0.09344);
    assert.deepEqual([...resolvePlantParameters(parameters, manifest, config)], parameters.map(({ key }) => config[key]));
    const definition = createVehiclePlantDefinition({}, { manifest }, { plantModel: plugin.model, physicsConfig: config });
    const body = new KinematicVehiclePlant(definition, { stepper: { physicsConfig: config, reset() {} } });
    assert.equal(body.physicsConfig, config);
    assert.equal(body.definition.physicsConfig, config);
    assert.equal(contactParameters(body), config);
    body.resetRunState();
    assert.equal(contactParameters(body), config);
    const builtin = resolveVehiclePhysicsConfig(rc({ model: CONTACT_BICYCLE_MODEL, ...rcDynamics }));
    assert.deepEqual(config, builtin);
    const declared = resolveVehiclePhysicsConfig(rc({ plant: plugin.id }), { ...plugin, parameters: [{ key: "mass", source: "default", default: 12 }] });
    assert.equal(declared.mass, 12);
    assert.equal(declared.yawInertia, DEFAULT_DYNAMIC_BICYCLE.yawInertia);
    const preciseDefault = resolveVehiclePhysicsConfig(rc({ plant: plugin.id }), { ...plugin, parameters: [{ key: "mass", source: "default", default: 12.123456789 }] });
    assert.equal(preciseDefault.mass, 12.123456789);
    assert.deepEqual([...resolvePlantParameters([
        { key: "wheelbase", source: "default", default: 2 },
        { key: "lf", source: "default", default: 1 },
    ], manifest, config)], [2, 1]);
});
