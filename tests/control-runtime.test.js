import assert from "node:assert/strict";
import test from "node:test";

import {
    normalizeStampedAckermannCommand,
    rep103SteeringToThree,
    threeSteeringToRep103,
    validateStampedAckermannCommand,
} from "../app/autonomy/ControlCommandAdapter.js";
import { ControlRuntime } from "../app/autonomy/ControlRuntime.js";

function stamped({
    sequence = 1,
    mode = "velocity",
    speed = 2,
    steering = 0.1,
    acceleration = 0,
    deadlineNs = null,
    sec = 0,
    nanosec = 0,
} = {}) {
    return {
        header: { stamp: { sec, nanosec }, frame_id: "base_link" },
        sequence,
        mode,
        deadline_ns: deadlineNs ?? 0,
        steering_angle: steering,
        steering_angle_velocity: 0,
        speed,
        acceleration,
        jerk: 0,
    };
}

test("stamped command validation rejects bad mode, sequence, and non-finite fields", () => {
    assert.equal(validateStampedAckermannCommand(null).ok, false);
    assert.equal(validateStampedAckermannCommand({ header: { stamp: { sec: 0, nanosec: 0 } }, mode: "warp", sequence: 1 }).ok, false);
    assert.equal(validateStampedAckermannCommand(stamped({ sequence: -1 })).ok, false);
    assert.equal(validateStampedAckermannCommand(stamped({ speed: Number.NaN })).ok, false);
    assert.equal(validateStampedAckermannCommand(stamped()).ok, true);
});

test("normalization converts REP-103 steering once at the actuator boundary", () => {
    const result = normalizeStampedAckermannCommand(stamped({ steering: 0.25, speed: 3 }));
    assert.equal(result.ok, true);
    assert.equal(result.command.steeringRadRep103, 0.25);
    assert.equal(result.command.steeringRadThree, rep103SteeringToThree(0.25));
    assert.equal(threeSteeringToRep103(result.command.steeringRadThree), 0.25);
});

test("control runtime applies velocity commands with saturation and keeps requested distinct", () => {
    const runtime = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            watchdogNs: 1e9,
            stalePolicy: "stop",
            actuatorOverrides: { maxSpeed: 5, maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100, responseDelayNs: 0 },
        },
    });
    runtime.configure({
        controls: runtime.controls,
        vehicleLimits: { ego: { maxSpeed: 5, maxSteeringAngle: 0.6, maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 } },
    });
    runtime.ingestStampedCommand({
        name: "/controls/command",
        value: stamped({ speed: 20, steering: 0.05, sequence: 1, nanosec: 1 }),
    }, { applyTimeNs: 1 });
    const applied = runtime.step({ step: 1, timeNs: 1, dt: 0.05 });
    const setpoint = applied.get("ego");
    assert.ok(setpoint.speedMps <= 5 + 1e-9);
    const snap = runtime.getSnapshot("ego", { applyTimeNs: 1 });
    assert.equal(snap.requested.speedMps, 20);
    assert.ok(snap.applied.speedMps <= 5 + 1e-9);
    assert.equal(snap.flags.saturated, true);
});

test("watchdog safe-stop fires when heartbeat expires", () => {
    const runtime = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            watchdogNs: 100_000_000,
            stalePolicy: "stop",
            actuatorOverrides: { maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 },
        },
    });
    runtime.configure({ controls: runtime.controls, vehicleLimits: { ego: {} } });
    runtime.ingestStampedCommand({
        name: "/controls/command",
        value: stamped({ speed: 4, sequence: 1, nanosec: 1 }),
    }, { applyTimeNs: 1 });
    runtime.step({ step: 1, timeNs: 1, dt: 0.05 });
    // No new command; advance past watchdog.
    const later = runtime.step({ step: 20, timeNs: 200_000_000, dt: 0.05 });
    assert.equal(later.get("ego").speedMps, 0);
    assert.equal(runtime.getSnapshot("ego", { applyTimeNs: 200_000_000 }).flags.timedOut, true);
});

test("hold and fallback stale policies preserve or substitute commands", () => {
    const hold = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            watchdogNs: 10,
            stalePolicy: "hold",
            actuatorOverrides: { maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 },
        },
    });
    hold.configure({ controls: hold.controls, vehicleLimits: { ego: {} } });
    hold.ingestStampedCommand({ name: "/controls/command", value: stamped({ speed: 3, sequence: 1, nanosec: 1 }) }, { applyTimeNs: 1 });
    hold.step({ step: 1, timeNs: 1, dt: 0.05 });
    const held = hold.step({ step: 2, timeNs: 100, dt: 0.05 }).get("ego");
    assert.ok(Math.abs(held.speedMps - 3) < 1e-6);

    const fallback = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            watchdogNs: 10,
            stalePolicy: "fallback",
            fallbackCommand: { mode: "velocity", speed: 1, steering_angle: 0 },
            actuatorOverrides: { maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 },
        },
    });
    fallback.configure({ controls: fallback.controls, vehicleLimits: { ego: {} } });
    fallback.ingestStampedCommand({ name: "/controls/command", value: stamped({ speed: 3, sequence: 1, nanosec: 1 }) }, { applyTimeNs: 1 });
    fallback.step({ step: 1, timeNs: 1, dt: 0.05 });
    const fb = fallback.step({ step: 2, timeNs: 100, dt: 0.05 }).get("ego");
    assert.ok(Math.abs(fb.speedMps - 1) < 1e-6);
    assert.equal(fallback.getSnapshot("ego", { applyTimeNs: 100 }).flags.fallbackActive, true);
});

test("response delay holds previous applied until ready time", () => {
    const runtime = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            watchdogNs: 1e12,
            stalePolicy: "stop",
            actuatorOverrides: {
                responseDelayNs: 50_000_000,
                maxAcceleration: 100,
                maxDeceleration: 100,
                maxSteeringRate: 100,
            },
        },
    });
    runtime.configure({ controls: runtime.controls, vehicleLimits: { ego: { responseDelayNs: 50_000_000 } } });
    runtime.ingestStampedCommand({ name: "/controls/command", value: stamped({ speed: 2, sequence: 1, nanosec: 0 }) }, { applyTimeNs: 0 });
    const first = runtime.step({ step: 1, timeNs: 0, dt: 0.05 }).get("ego");
    assert.equal(first.speedMps, 0);
    runtime.ingestStampedCommand({ name: "/controls/command", value: stamped({ speed: 2, sequence: 2, nanosec: 50_000_000 }) }, { applyTimeNs: 50_000_000 });
    // At ready time the delayed command from t=0 is released.
    const second = runtime.step({ step: 2, timeNs: 50_000_000, dt: 0.05 }).get("ego");
    assert.ok(Math.abs(second.speedMps - 2) < 1e-6);
});

test("sequence regression is rejected and authority selection is deterministic", () => {
    const runtime = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            referenceShadow: true,
            watchdogNs: 1e12,
            stalePolicy: "stop",
            actuatorOverrides: { maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 },
        },
    });
    runtime.configure({ controls: runtime.controls, vehicleLimits: { ego: {} } });
    assert.equal(runtime.ingestStampedCommand({
        name: "/controls/command",
        value: stamped({ speed: 2, sequence: 5, nanosec: 1 }),
    }, { applyTimeNs: 1 }).ok, true);
    assert.equal(runtime.ingestStampedCommand({
        name: "/controls/command",
        value: stamped({ speed: 9, sequence: 4, nanosec: 2 }),
    }, { applyTimeNs: 2 }).ok, false);

    runtime.submitSiSpeedSteer("ego", { speedMps: 1, steeringRadRep103: 0.2, producer: "reference", captureTimeNs: 1 });
    const applied = runtime.step({ step: 1, timeNs: 1, dt: 0.05 }).get("ego");
    assert.ok(Math.abs(applied.speedMps - 2) < 1e-6);
    assert.ok(runtime.getSnapshot("ego", { applyTimeNs: 1 }).referenceShadow);
});

test("achieved sampling stays distinct from applied under limits", () => {
    const runtime = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            watchdogNs: 1e12,
            stalePolicy: "stop",
            actuatorOverrides: { maxSpeed: 2, maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 },
        },
    });
    runtime.configure({ controls: runtime.controls, vehicleLimits: { ego: { maxSpeed: 2 } } });
    runtime.ingestStampedCommand({
        name: "/controls/command",
        value: stamped({ speed: 2, sequence: 1, nanosec: 1 }),
    }, { applyTimeNs: 1 });
    runtime.step({ step: 1, timeNs: 1, dt: 0.05 });
    runtime.sampleAchieved("ego", { speedMps: 1.5, steeringRadThree: 0, accelerationMps2: 0 });
    const snap = runtime.getSnapshot("ego", { applyTimeNs: 1 });
    assert.equal(snap.applied.speedMps, 2);
    assert.equal(snap.achieved.speedMps, 1.5);
    assert.ok(Math.abs(snap.deltas.appliedVsAchievedSpeed - 0.5) < 1e-9);
});
