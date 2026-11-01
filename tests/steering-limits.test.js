import assert from "node:assert/strict";
import test from "node:test";

import { KEYBOARD_STEER_RATE_RAD } from "../app/simulation/keyboardDrive.js";
import {
    clampPlaygroundSteerTarget,
    movePlaygroundSteerTarget,
    slewSteeringAngle,
    steeringAngleStop,
} from "../app/simulation/vehicles/steeringLimits.js";

const STOP = steeringAngleStop(0.6);

test("steering slew follows a step command and both signs", () => {
    const right = slewSteeringAngle({
        currentRad: 0,
        targetRad: 0.6,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 0.5,
        dtSeconds: 0.02,
    });
    assert.equal(right.rateLimited, true);
    assert.equal(right.saturated, false);
    assert.ok(Math.abs(right.angleRad - 0.01) < 1e-12);

    const left = slewSteeringAngle({
        currentRad: 0.01,
        targetRad: -0.6,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 0.5,
        dtSeconds: 0.02,
    });
    assert.equal(left.rateLimited, true);
    assert.ok(Math.abs(left.angleRad - (0.01 - 0.01)) < 1e-12);
});

test("steering slew clamps to the angle stop and passes a gap the rate already contains", () => {
    const pastStop = slewSteeringAngle({
        currentRad: 0,
        targetRad: 3,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 100,
        dtSeconds: 0.02,
    });
    assert.equal(pastStop.saturated, true);
    assert.equal(pastStop.rateLimited, false);
    assert.equal(pastStop.angleRad, STOP);

    const inside = slewSteeringAngle({
        currentRad: 0,
        targetRad: 0.02,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 2,
        dtSeconds: 0.02,
    });
    assert.equal(inside.rateLimited, false);
    assert.equal(inside.saturated, false);
    assert.equal(inside.angleRad, 0.02);
});

test("steering slew holds on a zero dt, a non-finite rate, and a non-finite target", () => {
    assert.equal(slewSteeringAngle({
        currentRad: 0.2,
        targetRad: 0.6,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 1.2,
        dtSeconds: 0,
    }).angleRad, 0.2);
    assert.equal(slewSteeringAngle({
        currentRad: 0.2,
        targetRad: 0.6,
        maxAngleRad: 0.6,
        maxRateRadPerSec: Number.NaN,
        dtSeconds: 0.02,
    }).angleRad, 0.2);
    assert.equal(slewSteeringAngle({
        currentRad: 0.2,
        targetRad: Number.NaN,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 1.2,
        dtSeconds: 0.02,
    }).angleRad, 0.2);
});

test("playground steer target uses the slower rate and the angle stop", () => {
    const keyboard = movePlaygroundSteerTarget(null, {
        currentRad: 0,
        direction: 1,
        dtSeconds: 0.1,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 2,
        keyboardRateRadPerSec: KEYBOARD_STEER_RATE_RAD,
    });
    assert.ok(Math.abs(keyboard - KEYBOARD_STEER_RATE_RAD * 0.1) < 1e-12);

    const vehicle = movePlaygroundSteerTarget(0, {
        direction: 1,
        dtSeconds: 1,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 0.2,
        keyboardRateRadPerSec: KEYBOARD_STEER_RATE_RAD,
    });
    assert.ok(Math.abs(vehicle - 0.2) < 1e-12);

    const held = movePlaygroundSteerTarget(STOP - 0.01, {
        direction: 1,
        dtSeconds: 1,
        maxAngleRad: 0.6,
        maxRateRadPerSec: 1,
        keyboardRateRadPerSec: 1,
    });
    assert.equal(held, STOP);
    assert.equal(clampPlaygroundSteerTarget(4, 0.6), STOP);
    assert.equal(clampPlaygroundSteerTarget(Number.NaN, 0.6), null);
});
