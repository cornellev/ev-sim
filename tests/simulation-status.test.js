import assert from "node:assert/strict";
import test from "node:test";

import {
    deriveSimulationStatus,
    formatClockMode,
    formatSimulationTime,
    summarizeAssertions,
} from "../app/3d/overlay/simulationStatus.js";

const manifestRun = {
    activeRunId: "run-test",
    activeResolved: { manifest: { id: "igvc-default" }, resolvedHash: "abc" },
};

test("simulation status distinguishes an unloaded scene from a manifest run", () => {
    assert.deepEqual(deriveSimulationStatus({ status: "idle" }, { status: "stopped" }), {
        label: "Scene loaded",
        detail: "No run manifest is active",
        tone: "zinc",
        source: "scene",
    });
    assert.equal(deriveSimulationStatus({ status: "idle" }, { status: "playing" }).label, "Scene running");
    assert.equal(deriveSimulationStatus({ ...manifestRun, status: "ready" }, { status: "paused" }).label, "Ready");
    assert.equal(deriveSimulationStatus({ ...manifestRun, status: "running" }, { status: "playing" }).label, "Running");
    assert.equal(deriveSimulationStatus({ ...manifestRun, status: "running", degraded: true }, { status: "playing" }).label, "Running, degraded");
    assert.equal(deriveSimulationStatus({ ...manifestRun, status: "assertion-failed" }, { status: "stopped" }).label, "Assertion failed");
});

test("simulation status formats exact clock, pacing, and assertion summaries", () => {
    assert.equal(formatSimulationTime(0), "00:00.000");
    assert.equal(formatSimulationTime(65.432), "01:05.432");
    assert.equal(formatSimulationTime(3661.25), "01:01:01.250");
    assert.equal(formatClockMode({ stepNs: 16_666_667, realtime: true, speed: 1 }), "60 Hz, Realtime, 1x");
    assert.deepEqual(summarizeAssertions([]), { label: "None", tone: "zinc" });
    assert.deepEqual(summarizeAssertions([{ status: "passed" }, { status: "pending" }]), { label: "1 pending", tone: "amber" });
    assert.deepEqual(summarizeAssertions([{ status: "failed" }]), { label: "1 failed", tone: "rose" });
});
