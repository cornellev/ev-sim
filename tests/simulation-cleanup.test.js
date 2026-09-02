import test from "node:test";
import assert from "node:assert/strict";

import {
    shouldShowSimulationCleanup,
    simulationCleanupPendingBytes,
    simulationCleanupProgress,
    simulationHasStoppedClock,
} from "../app/3d/overlay/simulationCleanup.js";

test("cleanup overlay appears only when the simulation clock is stopped with a log queue", () => {
    assert.equal(simulationHasStoppedClock({ status: "stopped" }), true);
    assert.equal(simulationHasStoppedClock({ status: "paused", lifecycleState: "finalized" }), true);
    assert.equal(simulationHasStoppedClock({ status: "paused" }), false);
    assert.equal(simulationHasStoppedClock({ status: "playing" }), false);

    assert.equal(shouldShowSimulationCleanup({ status: "stopped" }, {
        active: true,
        status: "recording",
        pendingBytes: 4096,
    }), true);
    assert.equal(shouldShowSimulationCleanup({ status: "paused", lifecycleState: "finalized" }, {
        active: true,
        status: "stopping",
        pendingBytes: 0,
    }), true);
    assert.equal(shouldShowSimulationCleanup({ status: "playing" }, {
        active: true,
        status: "recording",
        pendingBytes: 4096,
    }), false);
    assert.equal(shouldShowSimulationCleanup({ status: "paused" }, {
        active: true,
        status: "recording",
        pendingBytes: 4096,
    }), false);
    assert.equal(shouldShowSimulationCleanup({ status: "stopped" }, {
        active: false,
        status: "idle",
        pendingBytes: 0,
    }), false);
});

test("cleanup progress uses remaining queued bytes against the flush baseline", () => {
    assert.equal(simulationCleanupPendingBytes({ pendingBytes: 250, queuedBytes: 10 }), 250);
    assert.equal(simulationCleanupProgress({ flushProgress: 0.4 }, 1000), 0.4);
    assert.equal(simulationCleanupProgress({ pendingBytes: 250, flushTotalBytes: 1000 }), 0.75);
    assert.equal(simulationCleanupProgress({ pendingBytes: 250 }, 1000), 0.75);
    assert.equal(simulationCleanupProgress({ status: "stopping", pendingBytes: 0 }, 0), 1);
});
