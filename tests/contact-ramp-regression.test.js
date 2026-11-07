import assert from "node:assert/strict";
import test from "node:test";

import { buildImuMeasurement, captureVehicleSnapshot, createMeasurementSeedState } from "../app/autonomy/LocalizationMeasurements.js";
import { normalizeRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { SeededRNG } from "../app/util/SeededRNG.js";
import { LANDING_TREAD_TOLERANCE, replayContactRamp } from "./helpers/contactRampRegression.js";

test("the recorded 10 m ramp drop and keyboard sequence stay grounded and stop without a sideways runaway", async () => {
    const numeric = await replayContactRamp();
    const browser = await replayContactRamp({ browser: true });
    assert.equal(numeric.states.length, 774);
    assert.ok(numeric.floorSteps > 0, "must exercise road to floor support");
    assert.ok(numeric.maxLateralSpeed < 3, `sideways speed ${numeric.maxLateralSpeed}`);
    const config = normalizeRunSensor({ type: "imu", pose: {
        position: { x: 1, y: 0.2, z: 0.3 }, rotation: { x: 0, y: 0.3, z: 0.2 },
    } });
    const previous = [null, null];
    for (let index = 0; index < numeric.states.length; index += 1) {
        const a = numeric.states[index];
        const b = browser.states[index];
        for (const field of ["position", "rotation", "velocity", "acceleration", "bodyVelocity", "bodyAngularVelocity", "bodyAcceleration"]) {
            for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(a[field][axis] - b[field][axis]) <= 1e-9, `${index}: ${field}.${axis}`);
        }
        for (const field of ["lateralVelocity", "yawRate", "verticalVelocity"]) assert.ok(Math.abs(a[field] - b[field]) <= 1e-9);
        const measurements = [a, b].map((state, side) => {
            const snapshot = captureVehicleSnapshot({ ...state, motionModel: "contact-bicycle" }, (index + 1) * 16_666_667, previous[side]);
            previous[side] = snapshot;
            const rng = new SeededRNG(`ramp-imu:${index}`);
            return buildImuMeasurement(snapshot, config, rng, createMeasurementSeedState(config, rng)).measurement;
        });
        for (const field of ["angularVelocity", "linearAcceleration"]) {
            for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(measurements[0][field][axis] - measurements[1][field][axis]) <= 1e-9);
        }
        assert.ok(a.position.y >= 0.0171 - LANDING_TREAD_TOLERANCE, `tread below floor at step ${index + 1}`);
        assert.ok(Math.hypot(a.position.x, a.position.z) < 15, `runaway at step ${index + 1}`);
    }
    const final = numeric.states.at(-1);
    assert.ok(Math.hypot(final.velocity.x, final.lateralVelocity) < 0.01, `not stopped: ${JSON.stringify(final)}`);
    assert.equal(numeric.states[0].rotation.z, 0, "facing across the ramp does not pitch the nose uphill");
});
