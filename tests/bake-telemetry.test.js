import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { BakePath } from "../app/3d/environment/visualization/BakePath.js";
import {
    applyBakeTelemetryPatch,
    appendBakeEvent,
    calculateBakeEtaMs,
    calculateBakePercent,
    calculateBakeTotalSamples,
    createBakeTelemetrySnapshot,
    markBakeErrored,
    markBakeStopped,
} from "../app/3d/environment/visualization/BakeTelemetry.js";

function makePath(length) {
    return new BakePath([
        { position: new THREE.Vector3(0, 0, 0) },
        { position: new THREE.Vector3(length, 0, 0) },
    ]);
}

test("calculateBakeTotalSamples counts inclusive path samples", () => {
    assert.equal(calculateBakeTotalSamples([makePath(10)], 2), 6);
    assert.equal(calculateBakeTotalSamples([makePath(10), makePath(3)], 2), 8);
    assert.equal(calculateBakeTotalSamples([{ vertices: [] }], 2), 0);
    assert.equal(calculateBakeTotalSamples([makePath(10)], 0), 0);
});

test("calculateBakePercent clamps progress", () => {
    assert.equal(calculateBakePercent(0, 10), 0);
    assert.equal(calculateBakePercent(2, 8), 25);
    assert.equal(calculateBakePercent(99, 8), 100);
    assert.equal(calculateBakePercent(-3, 8), 0);
    assert.equal(calculateBakePercent(1, 0), 0);
});

test("calculateBakeEtaMs returns stable remaining time estimates", () => {
    assert.equal(calculateBakeEtaMs(1000, 0, 10), null);
    assert.equal(calculateBakeEtaMs(1000, 5, 10), 1000);
    assert.equal(calculateBakeEtaMs(1000, 10, 10), 0);
});

test("appendBakeEvent retains the newest events", () => {
    let events = [];
    for (let index = 0; index < 7; index += 1) {
        events = appendBakeEvent(events, {
            id: `event-${index}`,
            at: index,
            type: "test",
            message: `Event ${index}`,
        });
    }

    assert.equal(events.length, 5);
    assert.equal(events[0].id, "event-2");
    assert.equal(events[4].id, "event-6");
});

test("telemetry snapshots derive elapsed, percent, ETA, stop, and error states", () => {
    const initial = createBakeTelemetrySnapshot({
        runId: "run-1",
        now: 100,
    });

    const running = applyBakeTelemetryPatch(initial, {
        status: "running",
        stage: "LiDAR filtering",
        startedAt: 100,
        totalSamples: 10,
        completedSamples: 2,
    }, null, { now: 1100 });

    assert.equal(running.percent, 20);
    assert.equal(running.elapsedMs, 1000);
    assert.equal(running.etaMs, 4000);

    const stopped = markBakeStopped(running, { now: 1500 });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.stage, "Stopped");
    assert.equal(stopped.elapsedMs, 1400);
    assert.equal(stopped.warnings.at(-1).type, "stopped");

    const errored = markBakeErrored(running, new Error("Mask failed"), { now: 1600 });
    assert.equal(errored.status, "error");
    assert.equal(errored.error, "Mask failed");
    assert.equal(errored.warnings.at(-1).severity, "error");
});

test("telemetry snapshots merge manual advance controls", () => {
    const initial = createBakeTelemetrySnapshot();
    const manual = applyBakeTelemetryPatch(initial, {
        control: {
            manualAdvance: true,
            pendingManualSamples: 1,
        },
    });
    const drained = applyBakeTelemetryPatch(manual, {
        control: {
            pendingManualSamples: 0,
        },
    });

    assert.equal(manual.control.manualAdvance, true);
    assert.equal(manual.control.pendingManualSamples, 1);
    assert.equal(drained.control.manualAdvance, true);
    assert.equal(drained.control.pendingManualSamples, 0);
});
