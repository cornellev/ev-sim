import assert from "node:assert/strict";
import test from "node:test";

import {
    KEYBOARD_DRIVE_SPEED_MPS,
    KEYBOARD_STEER_RATE_RAD,
    createKeyboardDriveState,
    stepKeyboardDrive,
} from "../app/simulation/keyboardDrive.js";

const dt = 0.1;
const limits = { maxSpeed: 5, maxSteeringAngle: Math.PI / 3 };

test("keyboard drive stays quiet until a key is pressed", () => {
    const idle = createKeyboardDriveState();
    assert.deepEqual(stepKeyboardDrive(idle, { down: new Set(), dt, enabled: false }), {
        state: idle,
        command: null,
    });
    assert.deepEqual(stepKeyboardDrive(idle, { down: new Set(["w"]), dt, enabled: false }), {
        state: idle,
        command: null,
    });
    assert.deepEqual(stepKeyboardDrive(idle, { down: new Set(), dt, enabled: true }), {
        state: idle,
        command: null,
    });
});

test("keyboard drive maps WASD and holds the latched wheel", () => {
    const forward = stepKeyboardDrive(createKeyboardDriveState(), { down: new Set(["w"]), dt, enabled: true, limits });
    assert.equal(forward.command.speedMps, KEYBOARD_DRIVE_SPEED_MPS);
    assert.equal(forward.command.steeringRadRep103, 0);
    assert.equal(forward.command.mode, "velocity");

    const back = stepKeyboardDrive(forward.state, { down: new Set(["s"]), dt, enabled: true, limits });
    assert.equal(back.command.speedMps, -KEYBOARD_DRIVE_SPEED_MPS);

    const both = stepKeyboardDrive(back.state, { down: new Set(["w", "s"]), dt, enabled: true, limits });
    assert.equal(both.command.speedMps, KEYBOARD_DRIVE_SPEED_MPS);

    const left = stepKeyboardDrive(both.state, { down: new Set(["a"]), dt, enabled: true, limits });
    assert.equal(left.state.steeringRadThree, KEYBOARD_STEER_RATE_RAD * dt);
    assert.equal(left.command.steeringRadRep103, left.state.steeringRadThree);
    assert.equal(left.command.speedMps, 0);

    const right = stepKeyboardDrive(left.state, { down: new Set(["d"]), dt, enabled: true, limits });
    assert.equal(right.state.steeringRadThree, 0);

    const held = stepKeyboardDrive(left.state, { down: new Set(), dt, enabled: true, limits });
    assert.equal(held.command.speedMps, 0);
    assert.equal(held.command.steeringRadRep103, left.state.steeringRadThree);
    assert.equal(held.state.steeringRadThree, left.state.steeringRadThree);
});

test("keyboard limits prevent wind-up and opposite steering responds immediately", () => {
    const small = { maxSpeed: 1, maxSteeringAngle: Math.PI / 9 };
    const left = stepKeyboardDrive(createKeyboardDriveState(), { down: new Set(["w", "a"]), dt: 100, enabled: true, limits: small });
    assert.equal(left.command.speedMps, 1);
    assert.equal(left.state.steeringRadThree, small.maxSteeringAngle);
    const right = stepKeyboardDrive(left.state, { down: new Set(["d"]), dt, enabled: true, limits: small });
    assert.ok(right.state.steeringRadThree < small.maxSteeringAngle);
    const held = stepKeyboardDrive(right.state, { down: new Set(), dt, enabled: true, limits: small });
    assert.equal(held.state.steeringRadThree, right.state.steeringRadThree);
    assert.equal(stepKeyboardDrive(left.state, { down: new Set(["w"]), dt, enabled: true }).command, null);
    const both = stepKeyboardDrive(right.state, { down: new Set(["a", "d"]), dt, enabled: true, limits: small });
    assert.equal(both.state.steeringRadThree, right.state.steeringRadThree);
});

test("keyboard follows the real wheel when rate limits or delay keep it behind the request", () => {
    const slow = { maxSpeed: 1, maxSteeringAngle: Math.PI / 9, maxSteeringRate: 0.1 };
    const initial = stepKeyboardDrive(createKeyboardDriveState(), { down: new Set(["w"]), dt, enabled: true, limits: slow, currentSteeringRad: 0.2 });
    assert.equal(initial.command.steeringRadRep103, 0.2);
    const left = stepKeyboardDrive(initial.state, { down: new Set(["a"]), dt, enabled: true, limits: slow, currentSteeringRad: 0.2 });
    assert.equal(left.command.steeringRadRep103, 0.2 + 0.1 * dt);
    const right = stepKeyboardDrive({ latched: true, steeringRadThree: slow.maxSteeringAngle }, { down: new Set(["d"]), dt, enabled: true, limits: slow, currentSteeringRad: 0.2 });
    assert.equal(right.command.steeringRadRep103, 0.2 - 0.1 * dt);
});
