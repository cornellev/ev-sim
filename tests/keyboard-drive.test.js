import assert from "node:assert/strict";
import test from "node:test";

import {
    KEYBOARD_DRIVE_SPEED_MPS,
    KEYBOARD_STEER_RATE_RAD,
    createKeyboardDriveState,
    stepKeyboardDrive,
} from "../app/simulation/keyboardDrive.js";

const dt = 0.1;

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
    const forward = stepKeyboardDrive(createKeyboardDriveState(), { down: new Set(["w"]), dt, enabled: true });
    assert.equal(forward.command.speedMps, KEYBOARD_DRIVE_SPEED_MPS);
    assert.equal(forward.command.steeringRadRep103, 0);
    assert.equal(forward.command.mode, "velocity");

    const back = stepKeyboardDrive(forward.state, { down: new Set(["s"]), dt, enabled: true });
    assert.equal(back.command.speedMps, -KEYBOARD_DRIVE_SPEED_MPS);

    const both = stepKeyboardDrive(back.state, { down: new Set(["w", "s"]), dt, enabled: true });
    assert.equal(both.command.speedMps, KEYBOARD_DRIVE_SPEED_MPS);

    const left = stepKeyboardDrive(both.state, { down: new Set(["a"]), dt, enabled: true });
    assert.equal(left.state.steeringRadThree, KEYBOARD_STEER_RATE_RAD * dt);
    assert.equal(left.command.steeringRadRep103, -left.state.steeringRadThree);
    assert.equal(left.command.speedMps, 0);

    const right = stepKeyboardDrive(left.state, { down: new Set(["d"]), dt, enabled: true });
    assert.equal(right.state.steeringRadThree, 0);

    const held = stepKeyboardDrive(left.state, { down: new Set(), dt, enabled: true });
    assert.equal(held.command.speedMps, 0);
    assert.equal(held.command.steeringRadRep103, -left.state.steeringRadThree);
    assert.equal(held.state.steeringRadThree, left.state.steeringRadThree);
});
